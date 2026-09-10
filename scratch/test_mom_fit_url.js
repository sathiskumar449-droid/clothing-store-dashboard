import assert from 'node:assert/strict';
import { getCategoryUrl } from '../lib/categoryUrls.js';

const expectedUrl = 'https://www.supercollections.in/product-category/pants/mom-fit-pant/?utm_source=whatsapp';
const inputs = ['mom fit pant', 'Mom Fit Pant', 'mom fit pants', '  MOM   FIT   PANT  '];

for (const input of inputs) {
    assert.equal(getCategoryUrl(input), expectedUrl, `Wrong Mom Fit Pant URL for: ${input}`);
}

console.log('Mom Fit Pant URL tests passed.');
