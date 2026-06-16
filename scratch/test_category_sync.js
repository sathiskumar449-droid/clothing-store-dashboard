import dotenv from 'dotenv';
import { getParentCategory, getCategoryCounts, getSortedParents } from '../api/webhook.js';

dotenv.config();

function runTests() {
    console.log("=== Running Category Sync & Sorting Verification ===");

    // Test 1: Category Casing and Grouping Bypass
    console.log("\nTesting getParentCategory (Bypass generic grouping):");
    const testCases = [
        { input: "printed shirts", expected: "Printed Shirts" },
        { input: "linen shirts", expected: "Linen Shirts" },
        { input: "T-SHIRTS", expected: "T-shirts" },
        { input: "polo fit pant", expected: "Polo Fit Pant" },
        { input: "jeans", expected: "Jeans" },
        { input: "cargo track pant", expected: "Cargo Track Pant" }
    ];

    for (const tc of testCases) {
        const result = getParentCategory(tc.input);
        console.log(`  Input: "${tc.input}" => Output: "${result}" (Expected: "${tc.expected}")`);
        if (result !== tc.expected) {
            console.error(`  ❌ Mismatch for "${tc.input}"! Got "${result}" but expected "${tc.expected}"`);
            process.exit(1);
        }
    }
    console.log("✅ getParentCategory test passed!");

    // Test 2: Custom Keyword Sorting
    console.log("\nTesting getSortedParents (Custom sorting priority):");
    const mockCounts = {
        "Cargo Track Pant": 5,
        "Printed Shirts": 10,
        "Jeans": 8,
        "Linen Shirts": 4,
        "Polo Fit Pant": 12,
        "T-shirts": 15
    };

    const sorted = getSortedParents(mockCounts);
    console.log("Sorted output:", sorted);

    const expectedOrder = [
        "Printed Shirts",
        "Linen Shirts",
        "T-shirts",
        "Polo Fit Pant",
        "Jeans",
        "Cargo Track Pant"
    ];

    for (let i = 0; i < expectedOrder.length; i++) {
        if (sorted[i] !== expectedOrder[i]) {
            console.error(`  ❌ Order mismatch at index ${i}! Expected "${expectedOrder[i]}" but got "${sorted[i]}"`);
            process.exit(1);
        }
    }
    console.log("✅ getSortedParents test passed!");

    console.log("\n✅ WooCommerce Exact Category Sync and Custom Sorting Tests Passed successfully!");
}

runTests();
