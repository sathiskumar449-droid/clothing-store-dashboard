import sharp from 'sharp';
import axios from 'axios';
import { supabase } from './supabase.js';

function getDigitSvgPath(digit, x, y, width = 12, height = 20) {
    const paths = {
        '0': `M ${x} ${y} h ${width} v ${height} h -${width} z`,
        '1': `M ${x + width/2} ${y} v ${height}`,
        '2': `M ${x} ${y} h ${width} v ${height/2} h -${width} v ${height/2} h ${width}`,
        '3': `M ${x} ${y} h ${width} v ${height} h -${width} M ${x} ${y + height/2} h ${width}`,
        '4': `M ${x} ${y} v ${height/2} h ${width} M ${x + width} ${y} v ${height}`,
        '5': `M ${x + width} ${y} h -${width} v ${height/2} h ${width} v ${height/2} h -${width}`,
        '6': `M ${x + width} ${y} h -${width} v ${height} h ${width} v -${height/2} h -${width}`,
        '7': `M ${x} ${y} h ${width} v ${height}`,
        '8': `M ${x} ${y} h ${width} v ${height} h -${width} z M ${x} ${y + height/2} h ${width}`,
        '9': `M ${x + width} ${y + height/2} h -${width} v -${height/2} h ${width} v ${height} h -${width}`
    };
    return `<path d="${paths[digit] || ''}" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />`;
}

function getNumberSvg(number, startX = 45, startY = 35, digitWidth = 12, digitHeight = 20, spacing = 5) {
    const str = String(number);
    let currentX = startX - ((str.length * digitWidth + (str.length - 1) * spacing) / 2);
    let svg = '';
    for (let i = 0; i < str.length; i++) {
        svg += getDigitSvgPath(str[i], currentX, startY, digitWidth, digitHeight);
        currentX += digitWidth + spacing;
    }
    return svg;
}

// Helper to fetch remote image into a buffer
async function fetchImageBuffer(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 7000 });
        return Buffer.from(response.data);
    } catch (err) {
        console.error(`[Collage] Failed to fetch image from ${url}:`, err.message);
        return null;
    }
}



// Create fallback placeholder with overlay number using SVG
async function createPlaceholder(number) {
    const svgText = `
      <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
        <rect width="300" height="300" fill="#f8f9fa"/>
        <line x1="50" y1="50" x2="250" y2="250" stroke="#dee2e6" stroke-width="4" />
        <line x1="250" y1="50" x2="50" y2="250" stroke="#dee2e6" stroke-width="4" />
        <rect x="15" y="15" width="60" height="60" rx="12" fill="#000000" />
        ${getNumberSvg(number)}
      </svg>
    `;
    return sharp(Buffer.from(svgText)).png().toBuffer();
}

// Process a single product image: resize, crop, and (when showNumber) overlay the number.
// showNumber defaults to true since createRecommendationCollage still relies on numbered
// badges for its "reply 1 or 2" selection flow — createProductCollage (category-browse,
// which now sends a CTA button instead of a numbered list) is the only caller that opts out.
async function processProductImage(url, number, allowPlaceholder = true, showNumber = true) {
    let imgBuffer = null;
    if (url && url.startsWith('http')) {
        imgBuffer = await fetchImageBuffer(url);
    }

    if (!imgBuffer) {
        return allowPlaceholder ? createPlaceholder(number) : null;
    }

    const svgOverlay = `
      <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
        <rect x="15" y="15" width="60" height="60" rx="12" fill="#000000" />
        ${getNumberSvg(number)}
      </svg>
    `;

    try {
        const pipeline = sharp(imgBuffer).resize(300, 300, { fit: 'cover' });
        if (showNumber) {
            pipeline.composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }]);
        }
        return await pipeline.jpeg().toBuffer();
    } catch (err) {
        console.error(`[Collage] Sharp processing failed for ${url}:`, err.message);
        return allowPlaceholder ? createPlaceholder(number) : null;
    }
}

// Combine list of images into a single grid collage
async function generateCollage(productBuffers) {
    const count = productBuffers.length;
    if (count === 0) return null;

    // Dynamic Grid Columns calculation to completely avoid/minimize empty slots
    let cols = 2;
    if (count === 1) cols = 1;
    else if (count === 3) cols = 3;
    else if (count === 5 || count === 6) cols = 3;
    else if (count === 7 || count === 8) cols = 4;
    else if (count === 9) cols = 3;
    else if (count === 10) cols = 5;
    else if (count === 11 || count === 12) cols = 4;
    else if (count >= 13 && count <= 15) cols = 5;
    else if (count === 16) cols = 4;
    else if (count >= 17) cols = 5;

    const rows = Math.ceil(count / cols);
    const imgSize = 300;
    const spacing = 15;

    const width = cols * imgSize + (cols + 1) * spacing;
    const height = rows * imgSize + (rows + 1) * spacing;

    const composites = [];
    const lastRowIdx = rows - 1;
    const lastRowProductCount = count - (lastRowIdx * cols);

    for (let i = 0; i < count; i++) {
        const row = Math.floor(i / cols);
        let left;
        if (row < lastRowIdx) {
            const col = i % cols;
            left = spacing + col * (imgSize + spacing);
        } else {
            // Last row - center align
            const col = i % cols;
            const occupiedWidth = lastRowProductCount * imgSize + (lastRowProductCount - 1) * spacing;
            const startX = (width - occupiedWidth) / 2;
            left = startX + col * (imgSize + spacing);
        }
        const top = spacing + row * (imgSize + spacing);

        composites.push({
            input: productBuffers[i],
            top: Math.round(top),
            left: Math.round(left)
        });
    }

    return await sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 255, g: 255, b: 255 }
        }
    })
    .composite(composites)
    .jpeg({ quality: 85 })
    .toBuffer();
}

// Main function to ensure bucket, upload collage and return public URL
// Used exclusively by the category-browse path (enterSubCategoryByIndex /
// AWAITING_SUBCATEGORY_SELECTION), which now sends this collage alongside a "Shop
// [Category]" CTA button rather than a numbered product list — so no number badges.
export async function createProductCollage(productsPage, startNumber, allProducts = []) {
    try {
        // 1. Process all product images in parallel (do not allow fallback placeholders to avoid cross boxes)
        const processingPromises = productsPage.map((p, idx) => {
            let imgUri = p.imageUri || p.image_uri;
            if (!imgUri && allProducts.length > 0) {
                const matched = allProducts.find(prod => prod.id === p.id);
                if (matched) imgUri = matched.imageUri || matched.image_uri;
            }
            return processProductImage(imgUri, startNumber + idx, false, false);
        });

        const productBuffers = (await Promise.all(processingPromises)).filter(Boolean);

        // 2. Generate final collage
        const collageBuffer = await generateCollage(productBuffers);
        if (!collageBuffer) return null;

        // 3. Ensure Supabase Storage Bucket exists
        try {
            const { data: buckets } = await supabase.storage.listBuckets();
            if (!buckets || !buckets.some(b => b.name === 'collages')) {
                await supabase.storage.createBucket('collages', {
                    public: true,
                    allowedMimeTypes: ['image/jpeg', 'image/png']
                });
                console.log("[Collage] Created public bucket 'collages'");
            }
        } catch (bucketErr) {
            console.warn("[Collage] Bucket check/create skipped or failed:", bucketErr.message);
        }

        // 4. Upload collage to Supabase Storage
        const filename = `collage_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.jpg`;
        const { error: uploadError } = await supabase.storage
            .from('collages')
            .upload(filename, collageBuffer, {
                contentType: 'image/jpeg',
                cacheControl: '3600',
                upsert: true
            });

        if (uploadError) throw uploadError;

        // 5. Get public URL
        const { data } = supabase.storage
            .from('collages')
            .getPublicUrl(filename);

        console.log(`[Collage] Successfully uploaded collage: ${data.publicUrl}`);
        return data.publicUrl;
    } catch (err) {
        console.error("[Collage] Error generating product collage:", err.message);
        return null;
    }
}

export async function createRecommendationCollage(p1, p2, startNumber, allProducts = []) {
    try {
        let uri1 = p1.imageUri || p1.image_uri;
        let uri2 = p2.imageUri || p2.image_uri;
        
        if (!uri1 && allProducts.length > 0) {
            const matched = allProducts.find(prod => prod.id === p1.id);
            if (matched) uri1 = matched.imageUri || matched.image_uri;
        }
        if (!uri2 && allProducts.length > 0) {
            const matched = allProducts.find(prod => prod.id === p2.id);
            if (matched) uri2 = matched.imageUri || matched.image_uri;
        }

        const img1 = await processProductImage(uri1, startNumber);
        const img2 = await processProductImage(uri2, startNumber + 1);

        const collageBuffer = await sharp({
            create: {
                width: 600,
                height: 300,
                channels: 3,
                background: { r: 255, g: 255, b: 255 }
            }
        })
        .composite([
            { input: img1, top: 0, left: 0 },
            { input: img2, top: 0, left: 300 }
        ])
        .jpeg({ quality: 85 })
        .toBuffer();

        try {
            const { data: buckets } = await supabase.storage.listBuckets();
            if (!buckets || !buckets.some(b => b.name === 'collages')) {
                await supabase.storage.createBucket('collages', {
                    public: true,
                    allowedMimeTypes: ['image/jpeg', 'image/png']
                });
                console.log("[Collage] Created public bucket 'collages'");
            }
        } catch (bucketErr) {
            console.warn("[Collage] Bucket check/create skipped or failed:", bucketErr.message);
        }

        const filename = `rec_collage_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.jpg`;
        const { error: uploadError } = await supabase.storage
            .from('collages')
            .upload(filename, collageBuffer, {
                contentType: 'image/jpeg',
                cacheControl: '3600',
                upsert: true
            });

        if (uploadError) throw uploadError;

        const { data } = supabase.storage
            .from('collages')
            .getPublicUrl(filename);

        console.log(`[Collage] Successfully uploaded combo recommendation collage: ${data.publicUrl}`);
        return data.publicUrl;
    } catch (err) {
        console.error("[Collage] Error generating recommendation collage:", err.message);
        return null;
    }
}

async function processProductImageWithoutNumber(url) {
    let imgBuffer = null;
    if (url && url.startsWith('http')) {
        imgBuffer = await fetchImageBuffer(url);
    }

    if (!imgBuffer) {
        const svgText = `
          <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
            <rect width="300" height="300" fill="#f8f9fa"/>
            <line x1="50" y1="50" x2="250" y2="250" stroke="#dee2e6" stroke-width="4" />
            <line x1="250" y1="50" x2="50" y2="250" stroke="#dee2e6" stroke-width="4" />
          </svg>
        `;
        return sharp(Buffer.from(svgText)).png().toBuffer();
    }

    try {
        return await sharp(imgBuffer)
            .resize(300, 300, { fit: 'cover' })
            .jpeg()
            .toBuffer();
    } catch (err) {
        console.error(`[Collage] Sharp processing failed for ${url}:`, err.message);
        const svgText = `
          <svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
            <rect width="300" height="300" fill="#f8f9fa"/>
            <line x1="50" y1="50" x2="250" y2="250" stroke="#dee2e6" stroke-width="4" />
            <line x1="250" y1="50" x2="50" y2="250" stroke="#dee2e6" stroke-width="4" />
          </svg>
        `;
        return sharp(Buffer.from(svgText)).png().toBuffer();
    }
}

export async function createPromoCollage(productsPage, allProducts = []) {
    try {
        const count = productsPage.length;
        if (count === 0) return null;

        const processingPromises = productsPage.map(p => {
            let imgUri = p.imageUri || p.image_uri;
            if (!imgUri && allProducts.length > 0) {
                const matched = allProducts.find(prod => prod.id === p.id);
                if (matched) imgUri = matched.imageUri || matched.image_uri;
            }
            return processProductImageWithoutNumber(imgUri);
        });

        const productBuffers = await Promise.all(processingPromises);

        let collageBuffer;
        if (count === 1) {
            collageBuffer = productBuffers[0];
        } else if (count === 2) {
            collageBuffer = await sharp({
                create: {
                    width: 600,
                    height: 300,
                    channels: 3,
                    background: { r: 255, g: 255, b: 255 }
                }
            })
            .composite([
                { input: productBuffers[0], top: 0, left: 0 },
                { input: productBuffers[1], top: 0, left: 300 }
            ])
            .jpeg({ quality: 85 })
            .toBuffer();
        } else {
            const composites = [
                { input: productBuffers[0], top: 0, left: 0 },
                { input: productBuffers[1], top: 0, left: 300 }
            ];
            if (productBuffers[2]) {
                composites.push({ input: productBuffers[2], top: 300, left: 0 });
            }
            if (productBuffers[3]) {
                composites.push({ input: productBuffers[3], top: 300, left: 300 });
            }

            collageBuffer = await sharp({
                create: {
                    width: 600,
                    height: 600,
                    channels: 3,
                    background: { r: 255, g: 255, b: 255 }
                }
            })
            .composite(composites)
            .jpeg({ quality: 85 })
            .toBuffer();
        }

        try {
            const { data: buckets } = await supabase.storage.listBuckets();
            if (!buckets || !buckets.some(b => b.name === 'collages')) {
                await supabase.storage.createBucket('collages', {
                    public: true,
                    allowedMimeTypes: ['image/jpeg', 'image/png']
                });
            }
        } catch (bucketErr) {
            console.warn("[Collage] Bucket check/create skipped or failed:", bucketErr.message);
        }

        const filename = `promo_collage_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.jpg`;
        const { error: uploadError } = await supabase.storage
            .from('collages')
            .upload(filename, collageBuffer, {
                contentType: 'image/jpeg',
                cacheControl: '3600',
                upsert: true
            });

        if (uploadError) throw uploadError;

        const { data } = supabase.storage
            .from('collages')
            .getPublicUrl(filename);

        console.log(`[Collage] Successfully uploaded promo collage: ${data.publicUrl}`);
        return data.publicUrl;
    } catch (err) {
        console.error("[Collage] Error generating promo collage:", err.message);
        return null;
    }
}
