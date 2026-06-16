import dotenv from 'dotenv';
import { getParentCategory, getCategoryCounts, getSortedParents } from '../api/webhook.js';

dotenv.config();

function runTests() {
    console.log("=== Running Category Sync & Sorting Verification ===");

    // Test 1: Category Grouping
    console.log("\nTesting getParentCategory (Grouping into parent categories):");
    const testCases = [
        { input: "printed shirts", expected: "Shirts" },
        { input: "linen shirts", expected: "Shirts" },
        { input: "T-SHIRTS", expected: "T-Shirts" },
        { input: "polo fit pant", expected: "Pants" },
        { input: "jeans", expected: "Jeans" },
        { input: "cargo track pant", expected: "Pants" },
        { input: "Imported Shorts", expected: "Shorts" }
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

    // Test 2: Custom Group Sorting
    console.log("\nTesting getSortedParents (Custom sorting priority):");
    const mockCounts = {
        "Pants": 12,
        "Shorts": 6,
        "Shirts": 10,
        "T-Shirts": 15,
        "Jeans": 8
    };

    const sorted = getSortedParents(mockCounts);
    console.log("Sorted output:", sorted);

    const expectedOrder = [
        "Shirts",
        "T-Shirts",
        "Pants",
        "Jeans",
        "Shorts"
    ];

    for (let i = 0; i < expectedOrder.length; i++) {
        if (sorted[i] !== expectedOrder[i]) {
            console.error(`  ❌ Order mismatch at index ${i}! Expected "${expectedOrder[i]}" but got "${sorted[i]}"`);
            process.exit(1);
        }
    }
    console.log("✅ getSortedParents test passed!");

    console.log("\n✅ WooCommerce Category Grouping and Sorting Tests Passed successfully!");
}

runTests();
