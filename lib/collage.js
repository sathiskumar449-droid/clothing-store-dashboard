import sharp from 'sharp';
import axios from 'axios';
import { supabase } from './supabase.js';

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
    const fontSize = number >= 100 ? 24 : (number >= 10 ? 30 : 34);
    const svgText = `
      <svg width="300" height="300">
        <rect width="300" height="300" fill="#f8f9fa"/>
        <text x="150" y="160" font-family="system-ui, -apple-system, sans-serif" font-size="22" font-weight="600" fill="#adb5bd" text-anchor="middle">No Image</text>
        <rect x="15" y="15" width="60" height="60" rx="12" fill="#000000" />
        <text x="45" y="45" font-family="system-ui, -apple-system, sans-serif" font-size="${fontSize}" font-weight="900" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${number}</text>
      </svg>
    `;
    return sharp(Buffer.from(svgText)).png().toBuffer();
}

// Process a single product image: resize, crop, and overlay the number
async function processProductImage(url, number) {
    let imgBuffer = null;
    if (url && url.startsWith('http')) {
        imgBuffer = await fetchImageBuffer(url);
    }

    if (!imgBuffer) {
        return createPlaceholder(number);
    }

    const fontSize = number >= 100 ? 24 : (number >= 10 ? 30 : 34);
    const svgOverlay = `
      <svg width="300" height="300">
        <rect x="15" y="15" width="60" height="60" rx="12" fill="#000000" />
        <text x="45" y="45" font-family="system-ui, -apple-system, sans-serif" font-size="${fontSize}" font-weight="900" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${number}</text>
      </svg>
    `;

    try {
        return await sharp(imgBuffer)
            .resize(300, 300, { fit: 'cover' })
            .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
            .jpeg()
            .toBuffer();
    } catch (err) {
        console.error(`[Collage] Sharp processing failed for ${url}:`, err.message);
        return createPlaceholder(number);
    }
}

// Combine list of images into a single grid collage
async function generateCollage(productBuffers) {
    const count = productBuffers.length;
    if (count === 0) return null;

    // Grid Rules:
    // 1–4 products → 2 columns
    // 5–9 products → 3 columns
    // 10–16 products → 4 columns
    // 17–25 products → 5 columns
    let cols = 2;
    if (count >= 5 && count <= 9) {
        cols = 3;
    } else if (count >= 10 && count <= 16) {
        cols = 4;
    } else if (count >= 17) {
        cols = 5;
    }

    const rows = Math.ceil(count / cols);
    const imgSize = 300;
    const spacing = 15;
    const footerHeight = 60;

    const width = cols * imgSize + (cols + 1) * spacing;
    const gridHeight = rows * imgSize + (rows + 1) * spacing;
    const height = gridHeight + footerHeight;

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

    // Generate footer SVG
    const footerSvg = `
      <svg width="${width}" height="${footerHeight}">
        <rect width="${width}" height="${footerHeight}" fill="#ffffff"/>
        <text x="${width / 2}" y="${footerHeight / 2}" font-family="system-ui, -apple-system, sans-serif" font-size="16" font-weight="bold" fill="#111111" text-anchor="middle" dominant-baseline="central">Reply with the product number to continue.</text>
      </svg>
    `;

    composites.push({
        input: Buffer.from(footerSvg),
        top: gridHeight,
        left: 0
    });

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
export async function createProductCollage(productsPage, startNumber, allProducts = []) {
    try {
        // 1. Process all product images in parallel
        const processingPromises = productsPage.map((p, idx) => {
            let imgUri = p.imageUri || p.image_uri;
            if (!imgUri && allProducts.length > 0) {
                const matched = allProducts.find(prod => prod.id === p.id);
                if (matched) imgUri = matched.imageUri || matched.image_uri;
            }
            return processProductImage(imgUri, startNumber + idx);
        });

        const productBuffers = await Promise.all(processingPromises);

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
          <svg width="300" height="300">
            <rect width="300" height="300" fill="#f0f0f0"/>
            <style>
              .label-text { fill: #888888; font-size: 20px; font-family: sans-serif; }
            </style>
            <text x="150" y="150" text-anchor="middle" class="label-text">No Image</text>
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
          <svg width="300" height="300">
            <rect width="300" height="300" fill="#f0f0f0"/>
            <style>
              .label-text { fill: #888888; font-size: 20px; font-family: sans-serif; }
            </style>
            <text x="150" y="150" text-anchor="middle" class="label-text">No Image</text>
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
