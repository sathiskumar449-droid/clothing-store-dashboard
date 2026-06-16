import { handleSalesAssistantJS } from '../api/webhook.js';
import axios from 'axios';

// Mock axios to prevent 401 unauthorized errors during local testing
axios.post = async (url, data) => {
    console.log(`[AXIOS POST MOCK] URL: ${url}`);
    return { data: { messages: [{ id: 'wamid.mockid' }] } };
};
axios.get = async (url) => {
    console.log(`[AXIOS GET MOCK] URL: ${url}`);
    return { data: Buffer.alloc(0), headers: { 'content-type': 'image/jpeg' } };
};

const mockProducts = [
    { id: 1, name: 'Premium Plain Shirt', price: '699', stock: '10', sizes: 'M,L,XL', category: 'Casual Shirt', color: 'Black', imageUri: 'https://supercollections.in/plain_shirt.jpg' },
    { id: 2, name: 'Premium Printed Shirt', price: '799', stock: '5', sizes: 'S,M,L', category: 'Casual Shirt', color: 'White', imageUri: 'https://supercollections.in/printed_shirt.jpg' },
    { id: 3, name: 'Polo Fit Pant', price: '999', stock: '8', sizes: '30,32,34', category: 'Pants', color: 'Blue', imageUri: 'https://supercollections.in/navy_pant.jpg' },
    { id: 4, name: 'Cargo Track Pant', price: '599', stock: '12', sizes: 'M,L,XL', category: 'Cargo Pant', color: 'Green', imageUri: 'https://supercollections.in/cargo_pant.jpg' }
];

async function runFlow() {
    let session = {
        state: "AWAITING_CATEGORY",
        cart: [],
        history: [],
        searchProducts: [],
        selectedColor: null,
        selectedSize: null,
        lastRecommendation: null,
        awaitingRecommendationResponse: false,
        awaitingCartAdditionConfirmation: false,
        pendingProduct: null,
        crossSellShown: false
    };

    const steps = [
        { msg: "hi", desc: "Start chat" },
        { msg: "1", desc: "Select category 1 (Shirts)" },
        { msg: "1", desc: "Select product 1 (Premium Plain Shirt)" },
        { msg: "M", desc: "Select size M" },
        { msg: "qty_2", desc: "Select quantity 2" },
        { msg: "PANTS", desc: "Browse pants" },
        { msg: "2", desc: "Select subcategory 2 (Pants)" },
        { msg: "1", desc: "Select product 1 (Polo Fit Pant)" },
        { msg: "32", desc: "Select size 32" },
        { msg: "qty_1", desc: "Select quantity 1" },
        { msg: "no_checkout", desc: "Decline continue shopping, go to checkout" },
        { msg: "Ravi", desc: "Enter name" },
        { msg: "use_current_phone", desc: "Select use current phone number" },
        { msg: "642126", desc: "Enter pincode" },
        { msg: "12 Anna Nagar, Chennai", desc: "Enter door no & street address" },
        { msg: "confirm", desc: "Confirm the order details" }
    ];

    const phone = "1234567890";
    for (const step of steps) {
        console.log(`\n==============================================`);
        console.log(`👣 STEP: ${step.desc} | User Input: "${step.msg}"`);
        console.log(`State Before: ${session.state} | crossSellShown: ${session.crossSellShown}`);
        
        const response = await handleSalesAssistantJS(phone, step.msg, mockProducts, session);
        
        // Emulate handleMessage side-effects
        if (response.cart) session.cart = response.cart;
        if (response.selectedColor !== undefined) session.selectedColor = response.selectedColor;
        if (response.selectedSize !== undefined) session.selectedSize = response.selectedSize;
        if (response.searchProducts !== undefined) session.searchProducts = response.searchProducts;
        if (response.lastRecommendation !== undefined) session.lastRecommendation = response.lastRecommendation;
        if (response.awaitingRecommendationResponse !== undefined) session.awaitingRecommendationResponse = response.awaitingRecommendationResponse;
        if (response.awaitingCartAdditionConfirmation !== undefined) session.awaitingCartAdditionConfirmation = response.awaitingCartAdditionConfirmation;
        if (response.pendingProduct !== undefined) session.pendingProduct = response.pendingProduct;
        if (response.crossSellShown !== undefined) session.crossSellShown = response.crossSellShown;

        console.log(`Reply: ${response.replyText || (response.sendButtons ? response.sendButtons.body : (response.sendList ? response.sendList.body : 'N/A'))}`);
        if (response.sendImages && response.sendImages.length > 0) {
            console.log(`Images: ${JSON.stringify(response.sendImages)}`);
        }
        console.log(`State After : ${session.state} | crossSellShown: ${session.crossSellShown}`);
    }
}

runFlow().catch(console.error);

