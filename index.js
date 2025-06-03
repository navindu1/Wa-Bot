// Enhanced WhatsApp Bot with Order Management System
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
require('dotenv').config();

// V2ray panel configuration from .env
const PANEL_URL = process.env.PANEL_URL || 'https://sg1.navexnetsolutions.one:1234/navex';
const LOGIN_URL = `${PANEL_URL}/login`;
const CLIENT_TRAFFIC_URL = `${PANEL_URL}/panel/api/inbounds/getClientTraffics/`;
const INBOUNDS_URL = `${PANEL_URL}/panel/api/inbounds/list`;
const ADD_CLIENT_URL = `${PANEL_URL}/panel/api/inbounds/addClient`;

// Admin credentials from .env
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Username';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Passwords';

// Google Gemini API configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'your-gemini-api-key';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent';

// Admin WhatsApp number
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '94XXXXXXXXX@c.us'; // Format: country code + number + @c.us

// Vacation mode settings
const VACATION_MODE = process.env.VACATION_MODE === 'true' || false;
const VACATION_MESSAGE = process.env.VACATION_MESSAGE ||
    "*⚠️ AUTOMATED RESPONSE ⚠️*\n\nI'm currently on holiday and have limited internet access. " +
    "Your message has been logged and I'll review it when I return. " +
    "For urgent matters, please reply with 'URGENT' followed by your message.";

// File paths
const COOKIES_FILE = 'cookies.json';
const USER_DATA_FILE = 'user_data.json';
const MESSAGES_LOG_FILE = 'customer_messages.json';
const PROMOTION_DATA_FILE = 'promotion_data.json';
const ORDERS_FILE = 'customer_orders.json'; // New file for orders

// Store cookies
let cookies = '';

// Global variables
let userStates = {};
let customerMessages = {};
let customerOrders = {}; // Store all customer orders
let PROMOTION_MODE = process.env.PROMOTION_MODE === 'true' || false;
let promotionData = {
    active: false,
    participants: [],
    winners: [],
    endDate: null,
    task: {
        type: 'facebook_follow',
        details: 'Follow our Facebook page at facebook.com/nexguard and send a screenshot as proof'
    }
};

// Package configurations
const PACKAGES = {
    duration: {
        '1': { name: '1 Month', days: 30 },
        '2': { name: '2 Months', days: 60 },
        '3': { name: '6 Months', days: 180 },
        '4': { name: '1 Year', days: 365 }
    },
    deviceType: {
        '1': 'Dialog Router',
        '2': 'SLT Router',
        '3': 'SLT Fiber',
        '4': 'Hutch',
        '5': 'Airtel'
    },
    usageType: {
        '1': { name: 'Unlimited Usage', price: 800 },
        '2': { name: '200GB', price: 500 }
    }
};

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu'],
        headless: true
    }
});

// Memory cleanup interval (in milliseconds)
const MEMORY_CLEANUP_INTERVAL = 3600000; // 1 hour

// Performance optimizations
const MAX_CHAT_HISTORY = 5;
const MAX_LOG_ENTRIES_PER_USER = 50;

// Helper function for safe replies with fallback to direct message
async function safeReply(message, content) {
    try {
        await message.reply(content);
    } catch (error) {
        console.log('Reply failed, sending direct message:', error.message);
        try {
            await client.sendMessage(message.from, content);
        } catch (innerError) {
            console.error('Failed to send direct message too:', innerError.message);
        }
    }
}

// Show QR code for WhatsApp Web
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('QR code generated. Scan with WhatsApp to login.');
});

client.on('ready', () => {
    console.log('WhatsApp bot is ready!');
    // Initialize everything
    initializeBot();
    // Schedule memory cleanup
    setInterval(cleanupMemory, MEMORY_CLEANUP_INTERVAL);
});

// Initialize bot and load all data
async function initializeBot() {
    // Login to panel
    await loginToPanel();
    // Load saved data
    loadUserData();
    loadMessages();
    loadPromotionData();
    loadOrders();

    // Log status
    if (VACATION_MODE) {
        console.log('⚠️ Vacation mode is ACTIVE. Auto-responses and message forwarding enabled.');
    }
    
    if (PROMOTION_MODE) {
        console.log('🎁 Promotion mode is ACTIVE. Promotion option will be shown in menu.');
    }
}

// Load order data
function loadOrders() {
    try {
        if (fs.existsSync(ORDERS_FILE)) {
            const orderData = fs.readFileSync(ORDERS_FILE, 'utf8');
            customerOrders = JSON.parse(orderData);
            console.log(`Loaded ${Object.keys(customerOrders).length} customer orders`);
        } else {
            customerOrders = {};
            saveOrders(); // Create the file if it doesn't exist
        }
    } catch (error) {
        console.error('Error loading orders:', error);
        customerOrders = {};
    }
}

// Save orders to file
function saveOrders() {
    try {
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(customerOrders, null, 2));
    } catch (error) {
        console.error('Error saving orders:', error);
    }
}

// Memory cleanup function
function cleanupMemory() {
    console.log('Running memory cleanup...');
    
    // Cleanup chat histories for inactive users
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    
    Object.keys(userStates).forEach(userId => {
        // Reset state for users inactive for more than a day
        if (userStates[userId].lastActivity && (now - userStates[userId].lastActivity) > ONE_DAY) {
            userStates[userId].state = 'idle';
            userStates[userId].chatHistory = [];
        }
        
        // Limit chat history size
        if (userStates[userId].chatHistory && userStates[userId].chatHistory.length > MAX_CHAT_HISTORY) {
            userStates[userId].chatHistory = userStates[userId].chatHistory.slice(-MAX_CHAT_HISTORY);
        }
    });
    
    // Limit message logs per user
    Object.keys(customerMessages).forEach(userId => {
        if (customerMessages[userId].length > MAX_LOG_ENTRIES_PER_USER) {
            customerMessages[userId] = customerMessages[userId].slice(-MAX_LOG_ENTRIES_PER_USER);
        }
    });
    
    // Save the cleaned up data
    saveUserData();
    saveMessages();
    
    // Force garbage collection if supported
    if (global.gc) {
        global.gc();
    }
    
    console.log('Memory cleanup completed');
}

// Load promotion data
function loadPromotionData() {
    try {
        if (fs.existsSync(PROMOTION_DATA_FILE)) {
            const data = fs.readFileSync(PROMOTION_DATA_FILE, 'utf8');
            promotionData = JSON.parse(data);
            console.log(`Loaded promotion data with ${promotionData.participants.length} participants`);
            
            // Set the promotion mode based on loaded data
            PROMOTION_MODE = promotionData.active;
            console.log(`Promotion mode set to: ${PROMOTION_MODE}`);
        } else {
            savePromotionData(); // Create the file if it doesn't exist
        }
    } catch (error) {
        console.error('Error loading promotion data:', error);
        promotionData = {
            active: false,
            participants: [],
            winners: [],
            endDate: null,
            task: {
                type: 'facebook_follow',
                details: 'Follow our Facebook page at facebook.com/nexguard and send a screenshot as proof'
            }
        };
    }
}

// Save promotion data
function savePromotionData() {
    try {
        fs.writeFileSync(PROMOTION_DATA_FILE, JSON.stringify(promotionData, null, 2));
    } catch (error) {
        console.error('Error saving promotion data:', error);
    }
}

// Select random winners from promotion participants
function selectRandomWinners(count = 3) {
    if (promotionData.participants.length <= count) {
        return promotionData.participants;
    }
    
    const shuffled = [...promotionData.participants];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    return shuffled.slice(0, count);
}

// Load saved messages
function loadMessages() {
    try {
        if (fs.existsSync(MESSAGES_LOG_FILE)) {
            const messagesData = fs.readFileSync(MESSAGES_LOG_FILE, 'utf8');
            customerMessages = JSON.parse(messagesData);
            console.log(`Loaded ${Object.keys(customerMessages).length} customer message threads`);
        } else {
            customerMessages = {};
            saveMessages(); // Create the file if it doesn't exist
        }
    } catch (error) {
        console.error('Error loading messages:', error);
        customerMessages = {};
    }
}

// Save messages to file
function saveMessages() {
    try {
        fs.writeFileSync(MESSAGES_LOG_FILE, JSON.stringify(customerMessages, null, 2));
    } catch (error) {
        console.error('Error saving messages:', error);
    }
}

// Add a message to the log
function logCustomerMessage(senderId, senderName, message) {
    const timestamp = new Date().toISOString();

    // Initialize array for this customer if not exists
    if (!customerMessages[senderId]) {
        customerMessages[senderId] = [];
    }

    // Add message to log
    customerMessages[senderId].push({
        timestamp,
        name: senderName || 'Unknown',
        message: message.body,
        processed: false
    });

    // Limit the number of stored messages per user
    if (customerMessages[senderId].length > MAX_LOG_ENTRIES_PER_USER) {
        customerMessages[senderId] = customerMessages[senderId].slice(-MAX_LOG_ENTRIES_PER_USER);
    }

    // Save the updated messages
    saveMessages();
}

// Forward a message to the admin
async function forwardToAdmin(message, senderInfo) {
    try {
        const contact = await message.getContact();
        const contactName = contact.name || contact.pushname || 'Unknown';

        // Create a detailed message for the admin
        let adminMessage = `*📨 FORWARDED MESSAGE 📨*\n\n`;
        adminMessage += `*From:* ${contactName} (${message.from})\n`;
        adminMessage += `*Time:* ${new Date().toLocaleString()}\n`;
        adminMessage += `*Username:* ${senderInfo?.username || 'Not registered'}\n\n`;
        adminMessage += `*Message:*\n${message.body}`;

        // Forward to admin
        await client.sendMessage(ADMIN_NUMBER, adminMessage);
        console.log(`Message forwarded to admin from ${contactName}`);

        return true;
    } catch (error) {
        console.error('Error forwarding message to admin:', error);
        return false;
    }
}

// Check if a message is urgent
function isUrgentMessage(message) {
    if (!message || !message.body) return false;

    const content = message.body.trim().toUpperCase();
    return content === 'URGENT' || content.startsWith('URGENT ');
}

// Handle urgent messages
async function handleUrgentMessage(message, senderId) {
    try {
        const contact = await message.getContact();
        const contactName = contact.name || contact.pushname || 'Unknown';

        console.log(`Handling urgent message from ${contactName}`);

        // Log the urgent message
        logCustomerMessage(senderId, contactName, message);

        // Forward to admin
        const forwarded = await forwardToAdmin(message, userStates[senderId]);

        if (forwarded) {
            // Send confirmation to user
            await safeReply(message, "*🚨 Your urgent message has been forwarded to the team. We'll respond as soon as possible.*");
            return true;
        } else {
            // In case forwarding failed
            await safeReply(message, "*❌ Sorry, there was an issue forwarding your message. Please try again later.*");
            return false;
        }
    } catch (error) {
        console.error('Error handling urgent message:', error);
        await safeReply(message, "*❌ Sorry, there was an error processing your urgent message. Please try again.*");
        return false;
    }
}

// Load cookies if exist
function loadCookies() {
    try {
        if (fs.existsSync(COOKIES_FILE)) {
            const cookiesData = fs.readFileSync(COOKIES_FILE, 'utf8');
            cookies = JSON.parse(cookiesData).cookies;
            console.log('Cookies loaded from file');
            return true;
        }
    } catch (error) {
        console.error('Error loading cookies:', error);
    }
    return false;
}

// Save cookies to file
function saveCookies() {
    try {
        fs.writeFileSync(COOKIES_FILE, JSON.stringify({ cookies }));
    } catch (error) {
        console.error('Error saving cookies:', error);
    }
}

// Load saved user data
function loadUserData() {
    try {
        if (fs.existsSync(USER_DATA_FILE)) {
            const userData = fs.readFileSync(USER_DATA_FILE, 'utf8');
            const parsedData = JSON.parse(userData);

            // Initialize userStates with saved data
            Object.keys(parsedData).forEach(userId => {
                userStates[userId] = parsedData[userId];
                // Make sure state is set to idle
                userStates[userId].state = 'idle';
                // Initialize chat history if not exists
                if (!userStates[userId].chatHistory) {
                    userStates[userId].chatHistory = [];
                }
            });

            console.log(`Loaded ${Object.keys(parsedData).length} user records`);
        }
    } catch (error) {
        console.error('Error loading user data:', error);
    }
}

// Save user data to file
function saveUserData() {
    try {
        fs.writeFileSync(USER_DATA_FILE, JSON.stringify(userStates));
    } catch (error) {
        console.error('Error saving user data:', error);
    }
}

// Login to panel and get cookies
async function loginToPanel() {
    try {
        // First try to load existing cookies
        if (loadCookies()) {
            return true;
        }

        console.log('Attempting to login to panel...');
        const response = await axios.post(LOGIN_URL, {
            username: ADMIN_USERNAME,
            password: ADMIN_PASSWORD
        }, {
            withCredentials: true,
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
        });

        console.log('Login response status:', response.status);

        if (response.headers['set-cookie']) {
            cookies = response.headers['set-cookie'][0]; // Take the first cookie
            console.log('Successfully logged into panel. Cookie received.');
            saveCookies();
            return true;
        } else {
            console.error('No cookies received from login');
            return false;
        }
    } catch (error) {
        console.error('Login error:', error.message);
        return false;
    }
}

// Get user details by name
async function getUserByName(name) {
    try {
        console.log(`Searching for user with name: ${name}`);

        // Get client traffic details directly using name
        const trafficUrl = `${CLIENT_TRAFFIC_URL}${name}`;
        
        const trafficResponse = await axios.get(trafficUrl, {
            headers: {
                'Cookie': cookies
            }
        });

        if (!trafficResponse.data || !trafficResponse.data.success) {
            console.log('User not found or error:', trafficResponse.data);
            return { success: false, message: 'User not found or error retrieving data' };
        }

        // Return the user data directly from traffic response
        return {
            success: true,
            data: trafficResponse.data.obj,
            originalName: name  // Save the original name used
        };
    } catch (error) {
        console.error('Error getting user data:', error.message);

        // If unauthorized, try to re-login
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            console.log('Authentication error, attempting to re-login...');
            const loggedIn = await loginToPanel();
            if (loggedIn) {
                console.log('Re-logged in successfully, trying again...');
                return getUserByName(name);
            }
        }

        return { success: false, message: 'Error retrieving user data' };
    }
}

// Format user data for WhatsApp message
function formatUserData(userData, originalName) {
    try {
        let message = `*User Details 👾*\n`;
        message += `\n`;

        // Use the original name from the request if email is not available
        message += `👤 Name: ${originalName || 'Unknown'}\n`;

        // Convert expiry time from Unix timestamp to date if it exists
        if (userData.expiryTime) {
            const expiryDate = new Date(userData.expiryTime);
            message += `⏱️ Expires: ${expiryDate.toLocaleDateString()} ${expiryDate.toLocaleTimeString()}\n`;
        }

        // Traffic usage - with safety checks
        const download = formatBytes(userData.down || 0);
        const upload = formatBytes(userData.up || 0);
        const total = formatBytes((userData.down || 0) + (userData.up || 0));

        message += `⬇️ Download: ${download}\n`;
        message += `⬆️ Upload: ${upload}\n`;
        message += `📊 Total: ${total}\n`;

        // Status - with safety check
        const status = userData.enable !== undefined ? (userData.enable ? 'Enabled' : 'Disabled') : 'Unknown';
        message += `📶 Status: ${status}\n`;

        return message;
    } catch (error) {
        console.error('Error formatting user data:', error);
        return `*Error formatting data for ${originalName || 'user'}*\nPlease try again later.`;
    }
}

// Format bytes to human-readable format
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Generate a unique order ID
function generateOrderId() {
    return 'ORD-' + Math.floor(100000 + Math.random() * 900000);
}

// Create a new V2ray account via API
async function createV2rayAccount(username, email, expiryDays, traffic) {
    try {
        // First get the list of inbounds to find the ID
        const inboundsResponse = await axios.get(INBOUNDS_URL, {
            headers: {
                'Cookie': cookies
            }
        });

        if (!inboundsResponse.data || !inboundsResponse.data.success) {
            console.error('Failed to fetch inbounds');
            return { success: false, message: 'Failed to fetch inbounds' };
        }

        // Get the first inbound ID (can be modified to select specific inbound)
        const inboundId = inboundsResponse.data.obj[0].id;

        // Calculate expiry time
        const expiryTime = new Date();
        expiryTime.setDate(expiryTime.getDate() + expiryDays);

        // Prepare client data
        const clientData = {
            id: inboundId,
            settings: JSON.stringify({
                clients: [
                    {
                        id: generateUUID(),
                        email: email || username,
                        flow: "",
                        limitIp: 0,
                        totalGB: traffic === "unlimited" ? 0 : (parseInt(traffic) * 1024 * 1024 * 1024), // Convert GB to bytes
                        expiryTime: expiryTime.getTime(), // Convert to timestamp
                        enable: true,
                        tgId: "",
                        subId: ""
                    }
                ]
            })
        };

        // Send request to add client
        const addClientResponse = await axios.post(ADD_CLIENT_URL, clientData, {
            headers: {
                'Cookie': cookies,
                'Content-Type': 'application/json'
            }
        });

        if (!addClientResponse.data || !addClientResponse.data.success) {
            return { success: false, message: 'Failed to create account' };
        }

        return { 
            success: true, 
            message: 'Account created successfully',
            data: {
                username: username,
                expiry: expiryTime.toISOString(),
                inboundId: inboundId
            }
        };
    } catch (error) {
        console.error('Error creating V2ray account:', error.message);
        
        // If unauthorized, try to re-login
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            console.log('Authentication error, attempting to re-login...');
            const loggedIn = await loginToPanel();
            if (loggedIn) {
                console.log('Re-logged in successfully, trying again...');
                return createV2rayAccount(username, email, expiryDays, traffic);
            }
        }
        
        return { success: false, message: 'Error creating account: ' + error.message };
    }
}

// Generate a UUID for new clients
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Send welcome message with updated menu options
async function sendWelcomeMessage(message) {
    let welcomeText = `*Welcome To NexGuard ! 🚀💗*

*📡 1. Get V2ray Usage*
*📩 2. Contact FlyDeals.LK*
*🤖 3. Chat with Nexguard AI*
*🛒 4. Order V2ray Package*`;

    // Add complaint option if in vacation mode
    if (VACATION_MODE) {
        welcomeText += `\n*📝 5. File a Complaint/Issue*`;
    }
    
    // Add promotion option if promotion mode is active
    if (PROMOTION_MODE) {
        welcomeText += `\n*🎁 ${VACATION_MODE ? '6' : '5'}. Join Our Promotion*`;
    }

    welcomeText += `\n\n~👉 Please type the number of your choice.~`;

    await safeReply(message, welcomeText);
}

// Function to call Google Gemini API
async function callGeminiAI(prompt, chatHistory = []) {
    try {
        console.log('Calling Gemini API...');

        // Optimize: Only use the latest few messages to reduce tokens
        const recentHistory = chatHistory.slice(-MAX_CHAT_HISTORY);

        // Convert chat history to Gemini format
        const formattedHistory = recentHistory.map(msg => ({
            role: msg.role === "assistant" ? "model" : "user",
            parts: [{ text: msg.content }]
        }));

        // Add system prompt as the first user message if history is empty
        let contents = [];
        if (formattedHistory.length === 0) {
            contents = [
                {
                    role: "user",
                    parts: [{ text: "*Hi there! 👋 I'm NexGuard AI, your helpful assistant for NaxGuard 🚀. Need quick answers or support?*" }]
                },
                {
                    role: "model",
                    parts: [{ text: "*I understand. I'll act as Nexguard AI, providing concise, friendly, and informative responses as a helpful assistant for NaxGuard 🚀.*" }]
                }
            ];
        } else {
            contents = formattedHistory;
        }

        // Add the current user prompt
        contents.push({
            role: "user",
            parts: [{ text: prompt }]
        });

        // Make the API call with query parameter for API key
        const response = await axios.post(
            `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
            {
                contents: contents,
                generationConfig: {
                    maxOutputTokens: 800,
                    temperature: 0.7
                }
            },
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 30000 // 30 second timeout
            }
        );

        // Extract the AI response
        if (response.data &&
            response.data.candidates &&
            response.data.candidates.length > 0 &&
            response.data.candidates[0].content &&
            response.data.candidates[0].content.parts &&
            response.data.candidates[0].content.parts.length > 0) {

            return {
                success: true,
                message: response.data.candidates[0].content.parts[0].text
            };
        } else {
            console.error('Unexpected API response structure');
            return {
                success: false,
                message: '*Sorry, I received an unexpected response. Please try again later.*'
            };
        }
    } catch (error) {
        console.error('Gemini API error:', error.message);
        return {
            success: false,
            message: 'Sorry, there was an issue connecting to my brain. Please try again later.'
        };
    }
}

// Check if this is a group chat message
function isGroupChat(message) {
    // In WhatsApp, group chat IDs typically end with @g.us
    return message.from.endsWith('@g.us');
}

// Handle incoming messages
client.on('message', async (message) => {
    try {
        // Skip group messages
        if (isGroupChat(message)) {
            console.log(`Ignoring group message from ${message.from}`);
            return;
        }

        const senderId = message.from;
        const messageContent = message.body.trim();
        const lowerCaseContent = messageContent.toLowerCase();

        // Initialize user state if not exists
        if (!userStates[senderId]) {
            userStates[senderId] = {
                state: 'idle',
                chatHistory: [],
                lastActivity: Date.now()
            };
        } else {
            // Update last activity timestamp
            userStates[senderId].lastActivity = Date.now();
        }

        console.log(`Message from ${senderId}: ${messageContent}`);
        console.log(`Current state: ${userStates[senderId].state}`);

        // Get contact info for logging
        const contact = await message.getContact();
        const contactName = contact.name || contact.pushname || 'Unknown';

        // === ADMIN COMMANDS === //
        if (senderId === ADMIN_NUMBER) {
            // Process admin command
            const adminCommandResult = await processAdminCommand(message, lowerCaseContent, messageContent);
            if (adminCommandResult) return; // Command was processed, stop here
        }

        // === URGENT MESSAGE HANDLING === //
        if (senderId !== ADMIN_NUMBER && isUrgentMessage(message)) {
            console.log('Urgent message detected!');
            awaitawait.handleUrgentMessage(message, senderId);
            return; // Exit after handling urgent message
        }

        // === VACATION MODE HANDLING === //
        if (VACATION_MODE && senderId !== ADMIN_NUMBER) {
            // Log the message
            logCustomerMessage(senderId, contactName, message);
            
            // Check if this is the first message in this session
            if (userStates[senderId].state === 'idle') {
                await safeReply(message, VACATION_MESSAGE);
                
                // Forward to admin
                await forwardToAdmin(message, userStates[senderId]);
                
                userStates[senderId].state = 'vacation_notified';
                saveUserData();
                return;
            }
        }

        // === ORDER PROCESSING === //
        if (userStates[senderId].state.startsWith('order_')) {
            await processOrderState(message, senderId);
            return;
        }

        // === AI CHAT HANDLING === //
        if (userStates[senderId].state === 'ai_chat') {
            // End chat if user types "exit" or "quit"
            if (['exit', 'quit', 'stop', 'end'].includes(lowerCaseContent)) {
                userStates[senderId].state = 'idle';
                saveUserData();
                await safeReply(message, "*AI chat ended. What would you like to do next?*");
                await sendWelcomeMessage(message);
                return;
            }

            // Process AI chat
            // Store user message in history
            userStates[senderId].chatHistory.push({
                role: "user",
                content: messageContent
            });

            // Get AI response
            await safeReply(message, "*🤖 Thinking...*");
            
            const aiResponse = await callGeminiAI(
                messageContent, 
                userStates[senderId].chatHistory
            );

            // Store AI response
            if (aiResponse.success) {
                userStates[senderId].chatHistory.push({
                    role: "assistant",
                    content: aiResponse.message
                });
                
                // Trim history if it gets too long
                if (userStates[senderId].chatHistory.length > MAX_CHAT_HISTORY * 2) {
                    userStates[senderId].chatHistory = userStates[senderId].chatHistory.slice(-MAX_CHAT_HISTORY * 2);
                }
            }

            // Send response
            await safeReply(message, aiResponse.message);
            saveUserData();
            return;
        }

        // === PROMOTION HANDLING === //
        if (userStates[senderId].state.startsWith('promotion_')) {
            await processPromotionState(message, senderId);
            return;
        }

        // === MAIN MENU HANDLING === //
        switch (messageContent) {
            case '1':
                userStates[senderId].state = 'get_usage';
                await safeReply(message, "*Please enter your NexGuard username to check usage.*");
                break;

            case '2':
                userStates[senderId].state = 'contact';
                await safeReply(message, `*📩 Contact Options*\n\n*1.* Chat with us\n*2.* WhatsApp: +94XXXXXXXXX\n*3.* Email: support@nexguard.lk\n*4.* Facebook: facebook.com/nexguard\n\n_Please select an option or type your message directly._`);
                break;

            case '3':
                userStates[senderId].state = 'ai_chat';
                await safeReply(message, "*🤖 NexGuard AI Assistant activated!*\n\nI can answer questions about V2ray, our services, or general tech support. What would you like to know?\n\n_(Type 'exit' to return to main menu)_");
                break;

            case '4':
                // Initialize order state
                userStates[senderId].state = 'order_duration';
                userStates[senderId].order = {
                    id: generateOrderId(),
                    timestamp: new Date().toISOString(),
                    customer: contactName,
                    status: 'pending'
                };
                
                // Send order menu
                let durationMenu = "*📦 Select Package Duration*\n\n";
                Object.keys(PACKAGES.duration).forEach(key => {
                    durationMenu += `*${key}.* ${PACKAGES.duration[key].name}\n`;
                });
                durationMenu += "\n_Type the number of your choice._";
                
                await safeReply(message, durationMenu);
                break;

            case '5':
                if (VACATION_MODE) {
                    // Complaint form
                    userStates[senderId].state = 'complaint';
                    await safeReply(message, "*📝 Please describe your issue or complaint in detail, and we'll address it when we return.*");
                } else if (PROMOTION_MODE) {
                    // Promotion handling
                    userStates[senderId].state = 'promotion_info';
                    await processPromotionState(message, senderId);
                } else {
                    await safeReply(message, "*❌ Invalid option. Please select from the available options.*");
                    await sendWelcomeMessage(message);
                }
                break;

            case '6':
                if (VACATION_MODE && PROMOTION_MODE) {
                    // Promotion handling during vacation mode
                    userStates[senderId].state = 'promotion_info';
                    await processPromotionState(message, senderId);
                } else {
                    await safeReply(message, "*❌ Invalid option. Please select from the available options.*");
                    await sendWelcomeMessage(message);
                }
                break;

            default:
                // Check if user is checking usage
                if (userStates[senderId].state === 'get_usage') {
                    const username = messageContent;
                    await safeReply(message, "*🔍 Checking your usage...*");
                    
                    const userData = await getUserByName(username);
                    
                    if (userData.success) {
                        const formattedData = formatUserData(userData.data, userData.originalName);
                        await safeReply(message, formattedData);
                    } else {
                        await safeReply(message, "*❌ User not found or error occurred.*\nPlease check the username and try again.");
                    }
                    
                    // Reset state
                    userStates[senderId].state = 'idle';
                    saveUserData();
                    
                    // Show menu again
                    setTimeout(async () => {
                        await sendWelcomeMessage(message);
                    }, 1000);
                    
                } else if (userStates[senderId].state === 'complaint') {
                    // Log and forward complaint
                    logCustomerMessage(senderId, contactName, message);
                    await forwardToAdmin(message, userStates[senderId]);
                    
                    await safeReply(message, "*✅ Your complaint has been recorded and will be addressed when we return. Thank you for your patience.*");
                    
                    // Reset state
                    userStates[senderId].state = 'idle';
                    saveUserData();
                    
                    // Show menu again
                    setTimeout(async () => {
                        await sendWelcomeMessage(message);
                    }, 1000);
                    
                } else if (userStates[senderId].state === 'contact') {
                    // Forward the message to admin
                    logCustomerMessage(senderId, contactName, message);
                    await forwardToAdmin(message, userStates[senderId]);
                    
                    await safeReply(message, "*✅ Message sent! Our team will get back to you soon.*");
                    
                    // Reset state
                    userStates[senderId].state = 'idle';
                    saveUserData();
                    
                    // Show menu again
                    setTimeout(async () => {
                        await sendWelcomeMessage(message);
                    }, 1000);
                    
                } else {
                    // Welcome message for any other input when in idle state
                    await sendWelcomeMessage(message);
                }
                break;
        }

        // Save user state
        saveUserData();
        
    } catch (error) {
        console.error('Error processing message:', error);
        try {
            await safeReply(message, "*❌ Sorry, an error occurred. Please try again later.*");
        } catch (innerError) {
            console.error('Failed to send error message:', innerError);
        }
    }
});

// Process admin commands
async function processAdminCommand(message, lowerCaseContent, originalContent) {
    try {
        // Check if this is an admin command
        if (lowerCaseContent.startsWith('!') || lowerCaseContent.startsWith('/')) {
            const command = lowerCaseContent.substring(1).split(' ')[0];
            const args = originalContent.substring(command.length + 2).trim(); // +2 for the ! and space
            
            console.log(`Admin command detected: ${command}, Args: ${args}`);
            
            switch (command) {
                case 'vacation':
                    VACATION_MODE = !VACATION_MODE;
                    await safeReply(message, `*Vacation mode is now ${VACATION_MODE ? 'ACTIVE' : 'INACTIVE'}*`);
                    return true;

                case 'promo':
                    if (args.startsWith('start')) {
                        // Extract days from args (e.g., !promo start 7)
                        const days = parseInt(args.split(' ')[1]) || 7;
                        
                        // Set end date
                        const endDate = new Date();
                        endDate.setDate(endDate.getDate() + days);
                        
                        // Update promotion data
                        promotionData.active = true;
                        promotionData.endDate = endDate.toISOString();
                        promotionData.participants = [];
                        promotionData.winners = [];
                        
                        // Save promotion data
                        savePromotionData();
                        
                        // Update promotion mode
                        PROMOTION_MODE = true;
                        
                        await safeReply(message, `*🎉 Promotion started!*\nEnd date: ${endDate.toLocaleDateString()}\nDuration: ${days} days`);
                        
                    } else if (args.startsWith('end')) {
                        // End the promotion
                        promotionData.active = false;
                        savePromotionData();
                        PROMOTION_MODE = false;
                        
                        // Select winners
                        const winnerCount = parseInt(args.split(' ')[1]) || 3;
                        promotionData.winners = selectRandomWinners(winnerCount);
                        savePromotionData();
                        
                        // Format winners message
                        let winnersMsg = `*🏆 Promotion Winners 🏆*\n\n`;
                        if (promotionData.winners.length > 0) {
                            promotionData.winners.forEach((winner, index) => {
                                winnersMsg += `*${index + 1}.* ${winner.name} (${winner.number})\n`;
                            });
                        } else {
                            winnersMsg += `*No participants found.*`;
                        }
                        
                        await safeReply(message, `*Promotion ended!*\nTotal participants: ${promotionData.participants.length}\n\n${winnersMsg}`);
                        
                    } else if (args.startsWith('status')) {
                        // Show promotion status
                        let statusMsg = `*Promotion Status*\n\n`;
                        statusMsg += `*Active:* ${promotionData.active ? 'Yes' : 'No'}\n`;
                        statusMsg += `*Participants:* ${promotionData.participants.length}\n`;
                        
                        if (promotionData.endDate) {
                            const endDate = new Date(promotionData.endDate);
                            statusMsg += `*End Date:* ${endDate.toLocaleDateString()}\n`;
                            
                            // Calculate days remaining
                            const now = new Date();
                            const daysRemaining = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
                            statusMsg += `*Days Remaining:* ${daysRemaining}\n`;
                        }
                        
                        await safeReply(message, statusMsg);
                    }
                    return true;

                case 'broadcast':
                    if (!args) {
                        await safeReply(message, "*❌ Please provide a message to broadcast.*");
                        return true;
                    }

                    await safeReply(message, "*📣 Broadcasting message...*");
                    
                    // Get all users who have interacted with the bot
                    const userIds = Object.keys(userStates);
                    let sentCount = 0;
                    
                    for (const userId of userIds) {
                        try {
                            // Skip admin
                            if (userId === ADMIN_NUMBER) continue;
                            
                            // Send broadcast message
                            await client.sendMessage(userId, `*📢 ANNOUNCEMENT*\n\n${args}\n\n_This is an automated message._`);
                            sentCount++;
                            
                            // Add delay to prevent rate limiting
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        } catch (error) {
                            console.error(`Failed to send broadcast to ${userId}:`, error.message);
                        }
                    }
                    
                    await safeReply(message, `*✅ Broadcast sent to ${sentCount} users.*`);
                    return true;

                case 'stats':
                    // Generate statistics
                    const totalUsers = Object.keys(userStates).length;
                    const totalMessages = Object.values(customerMessages)
                        .reduce((sum, messages) => sum + messages.length, 0);
                    const totalOrders = Object.keys(customerOrders).length;
                    
                    let statsMsg = `*📊 Bot Statistics*\n\n`;
                    statsMsg += `*Total Users:* ${totalUsers}\n`;
                    statsMsg += `*Total Messages:* ${totalMessages}\n`;
                    statsMsg += `*Total Orders:* ${totalOrders}\n`;
                    statsMsg += `*Vacation Mode:* ${VACATION_MODE ? 'ACTIVE' : 'INACTIVE'}\n`;
                    statsMsg += `*Promotion Mode:* ${PROMOTION_MODE ? 'ACTIVE' : 'INACTIVE'}\n`;
                    
                    await safeReply(message, statsMsg);
                    return true;

                case 'help':
                    // Admin help menu
                    let helpMsg = `*🛠️ Admin Commands*\n\n`;
                    helpMsg += `*!vacation* - Toggle vacation mode\n`;
                    helpMsg += `*!promo start [days]* - Start promotion\n`;
                    helpMsg += `*!promo end [winners]* - End promotion\n`;
                    helpMsg += `*!promo status* - Show promotion status\n`;
                    helpMsg += `*!broadcast [message]* - Send message to all users\n`;
                    helpMsg += `*!stats* - Show bot statistics\n`;
                    helpMsg += `*!user [username]* - Get user details\n`;
                    helpMsg += `*!order [orderId]* - Get order details\n`;
                    helpMsg += `*!reset [userId]* - Reset user state\n`;
                    helpMsg += `*!createuser [username] [days] [traffic]* - Create new user\n`;
                    
                    await safeReply(message, helpMsg);
                    return true;

                case 'user':
                    if (!args) {
                        await safeReply(message, "*❌ Please provide a username.*");
                        return true;
                    }
                    
                    await safeReply(message, "*🔍 Looking up user...*");
                    
                    const userData = await getUserByName(args);
                    
                    if (userData.success) {
                        const formattedData = formatUserData(userData.data, userData.originalName);
                        await safeReply(message, formattedData);
                    } else {
                        await safeReply(message, "*❌ User not found or error occurred.*");
                    }
                    return true;

                case 'order':
                    if (!args) {
                        await safeReply(message, "*❌ Please provide an order ID.*");
                        return true;
                    }
                    
                    // Find order
                    const order = Object.values(customerOrders)
                        .find(order => order.id === args);
                    
                    if (order) {
                        // Format order details
                        let orderMsg = `*📋 Order #${order.id}*\n\n`;
                        orderMsg += `*Customer:* ${order.customer}\n`;
                        orderMsg += `*Date:* ${new Date(order.timestamp).toLocaleString()}\n`;
                        orderMsg += `*Status:* ${order.status}\n\n`;
                        
                        // Package details
                        orderMsg += `*Package Details:*\n`;
                        orderMsg += `*Duration:* ${PACKAGES.duration[order.duration].name}\n`;
                        orderMsg += `*Device:* ${PACKAGES.deviceType[order.deviceType]}\n`;
                        orderMsg += `*Usage:* ${PACKAGES.usageType[order.usageType].name}\n`;
                        orderMsg += `*Price:* Rs. ${order.totalPrice}\n`;
                        
                        // Customer details if available
                        if (order.contactNumber) {
                            orderMsg += `\n*Contact:* ${order.contactNumber}\n`;
                        }
                        
                        if (order.email) {
                            orderMsg += `*Email:* ${order.email}\n`;
                        }
                        
                        if (order.username) {
                            orderMsg += `*Username:* ${order.username}\n`;
                        }
                        
                        await safeReply(message, orderMsg);
                    } else {
                        await safeReply(message, "*❌ Order not found.*");
                    }
                    return true;

                case 'reset':
                    if (!args) {
                        await safeReply(message, "*❌ Please provide a user ID.*");
                        return true;
                    }
                    
                    // Check if user exists
                    if (userStates[args]) {
                        // Reset user state
                        userStates[args].state = 'idle';
                        userStates[args].chatHistory = [];
                        saveUserData();
                        
                        await safeReply(message, `*✅ User state reset for ${args}*`);
                    } else {
                        await safeReply(message, "*❌ User not found.*");
                    }
                    return true;

                case 'createuser':
                    // Format: !createuser username days traffic
                    const params = args.split(' ');
                    
                    if (params.length < 3) {
                        await safeReply(message, "*❌ Insufficient parameters. Format: !createuser username days traffic*");
                        return true;
                    }
                    
                    const username = params[0];
                    const days = parseInt(params[1]);
                    const traffic = params[2].toLowerCase() === 'unlimited' ? 'unlimited' : parseInt(params[2]);
                    
                    if (isNaN(days) || (traffic !== 'unlimited' && isNaN(traffic))) {
                        await safeReply(message, "*❌ Invalid parameters. Days must be a number and traffic must be 'unlimited' or a number (GB).*");
                        return true;
                    }
                    
                    await safeReply(message, `*🔄 Creating account for ${username}...*`);
                    
                    const result = await createV2rayAccount(username, username, days, traffic);
                    
                    if (result.success) {
                        await safeReply(message, `*✅ Account created successfully!*\n\n*Username:* ${username}\n*Expiry:* ${new Date(result.data.expiry).toLocaleDateString()}\n*Traffic:* ${traffic === 'unlimited' ? 'Unlimited' : traffic + ' GB'}`);
                    } else {
                        await safeReply(message, `*❌ Failed to create account:* ${result.message}`);
                    }
                    return true;
            }
        }
        
        return false; // Not an admin command
    } catch (error) {
        console.error('Error processing admin command:', error);
        await safeReply(message, "*❌ Error processing admin command.*");
        return true;
    }
}

// Process order states
async function processOrderState(message, senderId) {
    try {
        const messageContent = message.body.trim();
        const currentState = userStates[senderId].state;
        const order = userStates[senderId].order;
        
        console.log(`Processing order state: ${currentState}`);
        
        switch (currentState) {
            case 'order_duration':
                // Validate duration choice
                if (!PACKAGES.duration[messageContent]) {
                    await safeReply(message, "*❌ Invalid option. Please select a valid duration:*");
                    
                    // Resend options
                    let durationMenu = "*📦 Select Package Duration*\n\n";
                    Object.keys(PACKAGES.duration).forEach(key => {
                        durationMenu += `*${key}.* ${PACKAGES.duration[key].name}\n`;
                    });
                    durationMenu += "\n_Type the number of your choice._";
                    
                    await safeReply(message, durationMenu);
                    return;
                }
                
                // Store duration choice
                order.duration = messageContent;
                
                // Ask for device type
                userStates[senderId].state = 'order_device';
                
                let deviceMenu = "*📱 Select Your Device Type*\n\n";
                Object.keys(PACKAGES.deviceType).forEach(key => {
                    deviceMenu += `*${key}.* ${PACKAGES.deviceType[key]}\n`;
                });
                deviceMenu += "\n_Type the number of your choice._";
                
                await safeReply(message, deviceMenu);
                break;
                
            case 'order_device':
                // Validate device choice
                if (!PACKAGES.deviceType[messageContent]) {
                    await safeReply(message, "*❌ Invalid option. Please select a valid device type:*");
                    
                    // Resend options
                    let deviceMenu = "*📱 Select Your Device Type*\n\n";
                    Object.keys(PACKAGES.deviceType).forEach(key => {
                        deviceMenu += `*${key}.* ${PACKAGES.deviceType[key]}\n`;
                    });
                    deviceMenu += "\n_Type the number of your choice._";
                    
                    await safeReply(message, deviceMenu);
                    return;
                }
                
                // Store device choice
                order.deviceType = messageContent;
                
                // Ask for usage type
                userStates[senderId].state = 'order_usage';
                
                let usageMenu = "*📊 Select Usage Type*\n\n";
                Object.keys(PACKAGES.usageType).forEach(key => {
                    usageMenu += `*${key}.* ${PACKAGES.usageType[key].name} - Rs. ${PACKAGES.usageType[key].price}\n`;
                });
                usageMenu += "\n_Type the number of your choice._";
                
                await safeReply(message, usageMenu);
                break;
                
            case 'order_usage':
                // Validate usage choice
                if (!PACKAGES.usageType[messageContent]) {
                    await safeReply(message, "*❌ Invalid option. Please select a valid usage type:*");
                    
                    // Resend options
                    let usageMenu = "*📊 Select Usage Type*\n\n";
                    Object.keys(PACKAGES.usageType).forEach(key => {
                        usageMenu += `*${key}.* ${PACKAGES.usageType[key].name} - Rs. ${PACKAGES.usageType[key].price}\n`;
                    });
                    usageMenu += "\n_Type the number of your choice._";
                    
                    await safeReply(message, usageMenu);
                    return;
                }
                
                // Store usage choice and calculate price
                order.usageType = messageContent;
                order.totalPrice = PACKAGES.usageType[messageContent].price;
                
                // Ask for contact number
                userStates[senderId].state = 'order_contact';
                await safeReply(message, "*📞 Please enter your contact number:*");
                break;
                
            case 'order_contact':
                // Store contact number
                order.contactNumber = messageContent;
                
                // Ask for email
                userStates[senderId].state = 'order_email';
                await safeReply(message, "*📧 Please enter your email address:*");
                break;
                
            case 'order_email':
                // Store email
                order.email = messageContent;
                
                // Ask for preferred username
                userStates[senderId].state = 'order_username';
                await safeReply(message, "*👤 Please enter your preferred username for the V2ray account:*");
                break;
                
            case 'order_username':
                // Store username
                order.username = messageContent;
                
                // Confirm order
                userStates[senderId].state = 'order_confirm';
                
                // Generate summary
                let summary = `*📋 Order Summary*\n\n`;
                summary += `*Order ID:* ${order.id}\n`;
                summary += `*Package:* ${PACKAGES.duration[order.duration].name}\n`;
                summary += `*Device:* ${PACKAGES.deviceType[order.deviceType]}\n`;
                summary += `*Usage:* ${PACKAGES.usageType[order.usageType].name}\n`;
                summary += `*Price:* Rs. ${order.totalPrice}\n\n`;
                summary += `*Contact:* ${order.contactNumber}\n`;
                summary += `*Email:* ${order.email}\n`;
                summary += `*Username:* ${order.username}\n\n`;
                summary += `*To confirm your order, type 'confirm'*\n*To cancel, type 'cancel'*`;
                
                await safeReply(message, summary);
                break;
                
            case 'order_confirm':
                if (messageContent.toLowerCase() === 'confirm') {
                    // Update order status
                    order.status = 'confirmed';
                    
                    // Store order
                    if (!customerOrders[senderId]) {
                        customerOrders[senderId] = [];
                    }
                    customerOrders[senderId].push(order);
                    saveOrders();
                    
                    // Thank user
                    await safeReply(message, `*✅ Order Confirmed!*\n\nThank you for your order. Your order ID is *${order.id}*.\n\nOur team will process your order shortly and contact you with payment instructions. You can check your order status by contacting support with your order ID.`);
                    
                    // Notify admin
                    await notifyAdminAboutOrder(order, senderId);
                    
                    // Reset state
                    userStates[senderId].state = 'idle';
                    delete userStates[senderId].order;
                    saveUserData();
                    
                    // Show menu again
                    setTimeout(async () => {
                        await sendWelcomeMessage(message);
                    }, 1000);
                    
                } else if (messageContent.toLowerCase() === 'cancel') {
                    // Cancel order
                    await safeReply(message, "*❌ Order Cancelled*\n\nYour order has been cancelled. Feel free to place a new order whenever you're ready.");
                    
                    // Reset state
                    userStates[senderId].state = 'idle';
                    delete userStates[senderId].order;
                    saveUserData();
                    
                    // Show menu again
                    setTimeout(async () => {
                        await sendWelcomeMessage(message);
                    }, 1000);
                    
                } else {
                    // Invalid response
                    await safeReply(message, "*Please type 'confirm' to place your order or 'cancel' to cancel.*");
                }
                break;
        }
        
        // Save user state
        saveUserData();
        
    } catch (error) {
        console.error('Error processing order state:', error);
        await safeReply(message, "*❌ Sorry, an error occurred while processing your order. Please try again later.*");
        
        // Reset state
        userStates[senderId].state = 'idle';
        delete userStates[senderId].order;
        saveUserData();
    }
}

// Process promotion states
async function processPromotionState(message, senderId) {
    try {
        const messageContent = message.body.trim();
        const currentState = userStates[senderId].state;
        
        console.log(`Processing promotion state: ${currentState}`);
        
        switch (currentState) {
            case 'promotion_info':
                // Show promotion info
                if (!promotionData.active) {
                    await safeReply(message, "*❌ Sorry, the promotion is currently inactive. Please check back later.*");
                    
                    // Reset state
                    userStates[senderId].state = 'idle';
                    saveUserData();
                    
                    // Show menu again
                    setTimeout(async () => {
                        await sendWelcomeMessage(message);
                    }, 1000);
                    return;
                }
                
                // Check if already participated
                const alreadyParticipated = promotionData.participants.some(p => p.number === senderId);
                
                if (alreadyParticipated) {
                    await safeReply(message, "*✅ You're already registered for this promotion!*\n\nWinners will be announced after the promotion ends. Good luck!");
                    
                    // Reset state
                    userStates[senderId].state = 'idle';
                    saveUserData();
                    
                    // Show menu again
                    setTimeout(async () => {
                        await sendWelcomeMessage(message);
                    }, 1000);
                    return;
                }
                
                // Format promotion info
                const endDate = new Date(promotionData.endDate);
                
                let promoMsg = `*🎁 NexGuard Promotion*\n\n`;
                promoMsg += `Win free V2ray packages by completing a simple task!\n\n`;
                promoMsg += `*Task:* ${promotionData.task.details}\n\n`;
                promoMsg += `*Ends On:* ${endDate.toLocaleDateString()}\n`;
                promoMsg += `*Prizes:* Free V2ray packages\n\n`;
                promoMsg += `*To participate, send proof of completion as requested.*\n`;
                promoMsg += `*Type 'join' to continue.*`;
                
                await safeReply(message, promoMsg);
                
                // Update state
                userStates[senderId].state = 'promotion_join';
                saveUserData();
                break;case 'promotion_join':
                if (messageContent.toLowerCase() === 'join') {
                    // Update state
                    userStates[senderId].state = 'promotion_proof';
                    saveUserData();
                    
                    // Ask for proof
                    await safeReply(message, `*🎉 Great! Please complete the following task and send proof:*\n\n${promotionData.task.details}\n\n*Send a screenshot or photo as proof.*`);
                } else {
                    // Invalid response
                    await safeReply(message, "*Please type 'join' to participate in the promotion or send any other message to cancel.*");
                }
                break;
                
            case 'promotion_proof':
                // Check if the message has media
                if (message.hasMedia) {
                    // Get contact info
                    const contact = await message.getContact();
                    const contactName = contact.name || contact.pushname || 'Unknown';
                    
                    // Add to participants
                    promotionData.participants.push({
                        number: senderId,
                        name: contactName,
                        timestamp: new Date().toISOString()
                    });
                    
                    // Save promotion data
                    savePromotionData();
                    
                    // Confirm participation
                    await safeReply(message, "*✅ Thank you for participating!*\n\nYour entry has been recorded. Winners will be announced after the promotion ends. Good luck!");
                    
                    // Forward to admin
                    await forwardToAdmin(message, { 
                        message: "Promotion Entry",
                        username: contactName
                    });
                    
                    // Reset state
                    userStates[senderId].state = 'idle';
                    saveUserData();
                    
                    // Show menu again
                    setTimeout(async () => {
                        await sendWelcomeMessage(message);
                    }, 1000);
                } else {
                    // No media
                    await safeReply(message, "*❌ Please send a screenshot or photo as proof of completion.*");
                }
                break;
        }
    } catch (error) {
        console.error('Error processing promotion state:', error);
        await safeReply(message, "*❌ Sorry, an error occurred while processing your promotion entry. Please try again later.*");
        
        // Reset state
        userStates[senderId].state = 'idle';
        saveUserData();
    }
}

// Notify admin about new order
async function notifyAdminAboutOrder(order, customerId) {
    try {
        // Format order details
        let orderMsg = `*🛒 NEW ORDER RECEIVED 🛒*\n\n`;
        orderMsg += `*Order ID:* ${order.id}\n`;
        orderMsg += `*Customer:* ${order.customer}\n`;
        orderMsg += `*Customer ID:* ${customerId}\n`;
        orderMsg += `*Date:* ${new Date(order.timestamp).toLocaleString()}\n\n`;
        
        // Package details
        orderMsg += `*Package Details:*\n`;
        orderMsg += `*Duration:* ${PACKAGES.duration[order.duration].name}\n`;
        orderMsg += `*Device:* ${PACKAGES.deviceType[order.deviceType]}\n`;
        orderMsg += `*Usage:* ${PACKAGES.usageType[order.usageType].name}\n`;
        orderMsg += `*Price:* Rs. ${order.totalPrice}\n\n`;
        
        // Customer details
        orderMsg += `*Contact:* ${order.contactNumber}\n`;
        orderMsg += `*Email:* ${order.email}\n`;
        orderMsg += `*Username:* ${order.username}\n\n`;
        
        orderMsg += `_Use !order ${order.id} to view details anytime._`;
        
        // Send to admin
        await client.sendMessage(ADMIN_NUMBER, orderMsg);
        return true;
    } catch (error) {
        console.error('Error notifying admin about order:', error);
        return false;
    }
}

// Schedule tasks
function setupScheduledTasks() {
    // Daily report at midnight
    cron.schedule('0 0 * * *', async () => {
        console.log('Running daily report task');
        
        // Generate daily report
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        
        // Count messages from today
        let todayMessages = 0;
        Object.values(customerMessages).forEach(messages => {
            messages.forEach(msg => {
                const msgDate = new Date(msg.timestamp);
                if (msgDate >= todayStart) {
                    todayMessages++;
                }
            });
        });
        
        // Count orders from today
        let todayOrders = 0;
        Object.values(customerOrders).forEach(orders => {
            orders.forEach(order => {
                const orderDate = new Date(order.timestamp);
                if (orderDate >= todayStart) {
                    todayOrders++;
                }
            });
        });
        
        // Format report
        let reportMsg = `*📊 Daily Report - ${todayStart.toLocaleDateString()}*\n\n`;
        reportMsg += `*Messages:* ${todayMessages}\n`;
        reportMsg += `*Orders:* ${todayOrders}\n\n`;
        reportMsg += `*Total Users:* ${Object.keys(userStates).length}\n`;
        reportMsg += `*Total Orders:* ${Object.keys(customerOrders).reduce((sum, key) => sum + customerOrders[key].length, 0)}\n`;
        
        // Send to admin
        try {
            await client.sendMessage(ADMIN_NUMBER, reportMsg);
            console.log('Daily report sent to admin');
        } catch (error) {
            console.error('Error sending daily report:', error);
        }
    });
    
    // Check for expiring accounts daily
    cron.schedule('0 9 * * *', async () => {
        console.log('Checking for expiring accounts');
        
        // Logic to check for accounts expiring soon would go here
        // This would require integrating with the panel API to check expiration dates
        
        // For demonstration purposes, we'll just send a placeholder message
        try {
            await client.sendMessage(ADMIN_NUMBER, "*⚠️ Expiring Accounts Reminder*\n\nPlease check the panel for accounts expiring soon.");
            console.log('Expiring accounts reminder sent');
        } catch (error) {
            console.error('Error sending expiring accounts reminder:', error);
        }
    });
    
    // Re-login to panel every 12 hours to refresh cookies
    cron.schedule('0 */12 * * *', async () => {
        console.log('Re-logging into panel to refresh cookies');
        await loginToPanel();
    });
    
    // Backup data files weekly
    cron.schedule('0 0 * * 0', () => {
        console.log('Backing up data files');
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        // Backup user data
        try {
            fs.copyFileSync(USER_DATA_FILE, `${USER_DATA_FILE}.${timestamp}.bak`);
            console.log('User data backed up');
        } catch (error) {
            console.error('Error backing up user data:', error);
        }
        
        // Backup messages log
        try {
            fs.copyFileSync(MESSAGES_LOG_FILE, `${MESSAGES_LOG_FILE}.${timestamp}.bak`);
            console.log('Messages log backed up');
        } catch (error) {
            console.error('Error backing up messages log:', error);
        }
        
        // Backup orders
        try {
            fs.copyFileSync(ORDERS_FILE, `${ORDERS_FILE}.${timestamp}.bak`);
            console.log('Orders backed up');
        } catch (error) {
            console.error('Error backing up orders:', error);
        }
        
        // Cleanup old backups (keep only last 4)
        ['bak'].forEach(ext => {
            try {
                const files = fs.readdirSync('.').filter(file => file.endsWith(`.${ext}`));
                files.sort();
                
                // If more than 4 backups, delete the oldest ones
                if (files.length > 4) {
                    for (let i = 0; i < files.length - 4; i++) {
                        fs.unlinkSync(files[i]);
                        console.log(`Deleted old backup: ${files[i]}`);
                    }
                }
            } catch (error) {
                console.error('Error cleaning up old backups:', error);
            }
        });
    });
}

// Initialize scheduled tasks
setupScheduledTasks();

// Handle disconnects
client.on('disconnected', (reason) => {
    console.log('Client was disconnected:', reason);
    // Attempt to reconnect after delay
    setTimeout(() => {
        console.log('Attempting to reconnect...');
        client.initialize();
    }, 5000);
});

// Initialize client
client.initialize();

// Handle process termination gracefully
process.on('SIGINT', () => {
    console.log('Shutting down gracefully...');
    saveUserData();
    saveMessages();
    saveOrders();
    savePromotionData();
    process.exit(0);
});

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't crash - just log
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Save data before potential crash
    saveUserData();
    saveMessages();
    saveOrders();
    savePromotionData();
    // Don't exit - let the process continue if possible
});

console.log('WhatsApp bot initialization complete. Waiting for QR code...');