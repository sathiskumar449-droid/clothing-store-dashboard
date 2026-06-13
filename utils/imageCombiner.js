import sharp from 'sharp';

/**
 * Combines two images (shirt and pant) side by side into a single image buffer.
 * Returning a buffer is ideal for uploading straight to a cloud storage (like Supabase)
 * or passing as base64 to an API without writing to disk.
 * 
 * @param {string | Buffer} shirtImageInput - Path or Buffer for the shirt
 * @param {string | Buffer} pantImageInput - Path or Buffer for the pant
 * @param {string} [outputPath] - Optional file path if you want to save it locally
 * @returns {Promise<Buffer>} - Returns the image buffer
 */
export async function combineOutfitImages(shirtImageInput, pantImageInput, outputPath = null) {
  try {
    // Tip: If you are using image URLs from your database, you must fetch() them as Buffers first:
    // const fetchBuffer = async (url) => Buffer.from(await (await fetch(url)).arrayBuffer());
    // const shirtBuff = await fetchBuffer(shirtData.image_url);

    // 1. Get metadata for both images to calculate canvas size
    const shirtMeta = await sharp(shirtImageInput).metadata();
    const pantMeta = await sharp(pantImageInput).metadata();

    // 2. Set canvas dimensions
    const canvasWidth = shirtMeta.width + pantMeta.width;
    const canvasHeight = Math.max(shirtMeta.height, pantMeta.height); // Height matches the tallest image

    // 3. Create a base canvas and composite images onto it
    const imageBuilder = sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 4, 
        background: { r: 255, g: 255, b: 255, alpha: 1 } // Solid white background
      }
    })
    .composite([
      { input: shirtImageInput, top: 0, left: 0 },
      { input: pantImageInput, top: 0, left: shirtMeta.width } // Place pant image to the right
    ])
    .png(); // Format as PNG

    // 4. If an output path is provided, save it to disk
    if (outputPath) {
      await imageBuilder.toFile(outputPath);
      console.log(`Saved composite image to ${outputPath}`);
    }

    // 5. Always return the image buffer for API usage
    return await imageBuilder.toBuffer();

  } catch (error) {
    console.error("Error combining outfit images with Sharp:", error);
    throw error;
  }
}
