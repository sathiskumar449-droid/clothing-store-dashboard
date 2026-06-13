/**
 * Utility to send messages using Meta's WhatsApp Cloud API
 */

// Place these in your .env file
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'YOUR_TEMPORARY_ACCESS_TOKEN'; 
const PHONE_NUMBER_ID = process.env.PHONE_ID || process.env.PHONE_NUMBER_ID || 'YOUR_PHONE_NUMBER_ID';

/**
 * Core function that handles the Fetch request
 */
export async function sendWhatsAppMessage(to, payload) {
    if (!WHATSAPP_TOKEN || WHATSAPP_TOKEN === 'YOUR_TEMPORARY_ACCESS_TOKEN') {
        throw new Error('Missing WhatsApp config: set WHATSAPP_TOKEN in .env');
    }

    if (!PHONE_NUMBER_ID || PHONE_NUMBER_ID === 'YOUR_PHONE_NUMBER_ID') {
        throw new Error('Missing WhatsApp config: set PHONE_ID or PHONE_NUMBER_ID in .env');
    }

    const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to: to,
                ...payload // Injects the specific message content (text, image, interactive, etc)
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(`WhatsApp API Error: ${data.error?.message || 'Unknown Error'}`);
        }
        
        console.log("✅ Message sent securely!");
        return data;
    } catch (error) {
        console.error("❌ Failed to send WhatsApp message:", error.message);
        throw error;
    }
}

/**
 * 1. Helper to send standard Text
 */
export async function sendText(to, text) {
    return await sendWhatsAppMessage(to, {
        type: "text",
        text: { body: text }
    });
}

/**
 * 2. Helper to send an Image with a Caption
 */
export async function sendImage(to, imageUrl, caption) {
    return await sendWhatsAppMessage(to, {
        type: "image",
        image: {
            link: imageUrl,
            caption: caption
        }
    });
}

/**
 * 3. Helper to send an Interactive List (e.g., Matching Pants)
 */
export async function sendPantsList(to, pantsArray) {
    // Format the database pants array into WhatsApp List Rows
    const rows = pantsArray.map((pant) => ({
        id: pant.code, // sending product code back when user clicks
        title: pant.name.substring(0, 24), // WhatsApp limits title to 24 chars
        description: `Price: ₹${pant.price}`
    }));

    return await sendWhatsAppMessage(to, {
        type: "interactive",
        interactive: {
            type: "list",
            header: {
                type: "text",
                text: "Matching Pants ✨"
            },
            body: {
                text: "உங்களுக்குப் பிடித்த சரியான combination-ஐ தேர்ந்தெடுங்கள்!"
            },
            footer: {
                text: "Get Combo Offer!"
            },
            action: {
                button: "View Pants",
                sections: [
                    {
                        title: "Recommended",
                        rows: rows // Dynamically injects the pants list
                    }
                ]
            }
        }
    });
}
