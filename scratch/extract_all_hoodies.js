import fs from 'fs';

const html = fs.readFileSync('scratch/hoody_page.html', 'utf8');

const products = [];
for (const id of [20446, 20445, 20444, 20443]) {
    const i = html.indexOf(`data-id="${id}"`);
    if (i !== -1) {
        const chunk = html.substring(i, i + 6000);
        const nameMatch = chunk.match(/<h[23][^>]*class="[^"]*wd-entities-title[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/);
        const linkMatch = chunk.match(/<h[23][^>]*class="[^"]*wd-entities-title[^"]*"[^>]*>\s*<a\s+href="([^"]+)"/);
        const imgMatch = chunk.match(/<img[^>]+src="([^"]+\.jpe?g)"/);
        const skuMatch = chunk.match(/data-product_sku="([^"]+)"/);
        const priceMatch = chunk.match(/<ins><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol"[^>]*>&#8377;<\/span>([^<]+)<\/bdi>/) || chunk.match(/<span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol"[^>]*>&#8377;<\/span>([^<]+)<\/bdi>/);

        products.push({
            id: Number(id),
            name: nameMatch ? nameMatch[1].replace(/&#8211;/g, '-').trim() : '',
            permalink: linkMatch ? linkMatch[1].trim() : '',
            image_uri: imgMatch ? imgMatch[1].trim() : '',
            code: skuMatch ? skuMatch[1].trim() : '',
            price: '399',
            stock: '10',
            sizes: ['M', 'L', 'XL', 'XXL'],
            category: 'Hoody',
            categories: ['Hoody'],
            status: 'publish'
        });
    }
}

console.log('Extracted products:', JSON.stringify(products, null, 2));
