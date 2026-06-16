import sharp from 'sharp';
import fs from 'fs';

async function test() {
    const families = [
        "sans-serif",
        "Arial",
        "Segoe UI",
        "system-ui",
        "DejaVu Sans",
        "Liberation Sans"
    ];

    let svgContent = `<svg width="800" height="400" xmlns="http://www.w3.org/2000/svg">
        <rect width="800" height="400" fill="#ffffff"/>`;

    families.forEach((font, idx) => {
        const y = 50 + idx * 50;
        svgContent += `
        <text x="50" y="${y}" font-family="${font}" font-size="24" fill="#000000">${font}: 1 2 3 4 5 Reply with the product number to continue.</text>
        `;
    });

    svgContent += `</svg>`;

    await sharp(Buffer.from(svgContent))
        .png()
        .toFile('scratch/font_test.png');
    
    console.log("✅ Generated scratch/font_test.png");
}

test();
