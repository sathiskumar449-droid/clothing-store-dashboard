import axios from 'axios';

// Mock axios to prevent real Meta API network calls during testing
axios.post = async (url, data) => {
    console.log(`[AXIOS POST MOCK] URL: ${url}`);
    return { data: { messages: [{ id: 'wamid.mockid' }] } };
};
axios.get = async (url) => {
    console.log(`[AXIOS GET MOCK] URL: ${url}`);
    return { data: Buffer.alloc(0), headers: { 'content-type': 'image/jpeg' } };
};

import { getCategoryCounts, getSortedParents } from '../api/webhook.js';
import { handleSalesAssistantJS } from '../api/webhook.js';

const mockProducts = [
    { id: 1, name: 'Premium Plain Shirt', price: '699', stock: '10', sizes: 'M,L,XL', category: 'Casual Shirt', color: 'Black', imageUri: 'https://supercollections.in/plain_shirt.jpg' },
    { id: 2, name: 'Premium Printed Shirt', price: '799', stock: '5', sizes: 'S,M,L', category: 'Casual Shirt', color: 'White', imageUri: 'https://supercollections.in/printed_shirt.jpg' },
    { id: 3, name: 'Polo Fit Pant', price: '999', stock: '8', sizes: '30,32,34', category: 'Pants', color: 'Blue', imageUri: 'https://supercollections.in/navy_pant.jpg' },
    { id: 4, name: 'Cargo Track Pant', price: '599', stock: '12', sizes: 'M,L,XL', category: 'Cargo Pant', color: 'Green', imageUri: 'https://supercollections.in/cargo_pant.jpg' }
];

async function runVerify() {
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

    console.log("--- Category Selection Response ---");
    let res = await handleSalesAssistantJS("1234567890", "hi", mockProducts, session);
    console.log(JSON.stringify(res.sendList, null, 2));

    console.log("\n--- Subcategory Selection Response ---");
    session.state = "AWAITING_SUBCATEGORY_SELECTION";
    session.subCategories = ["Cargo Pant", "Pants"];
    session.selectedParentCategory = "Pants";
    res = await handleSalesAssistantJS("1234567890", "1", mockProducts, session); // user selects Cargo Pant
    console.log(JSON.stringify(res.sendList, null, 2));
}

runVerify().catch(console.error);
