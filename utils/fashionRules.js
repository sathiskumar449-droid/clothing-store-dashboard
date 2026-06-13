export function getMatchingPantsColors(shirtPattern) {
    let allowedColors = [];

    switch (shirtPattern) {
        case 'plain':
            // Plain shirt → navy, black pants
            allowedColors = ['Navy Blue', 'Navy', 'Black'];
            break;
        case 'checked':
            // Checked shirt → plain black or grey pants
            allowedColors = ['Black', 'Grey'];
            break;
        case 'printed':
            // Printed shirt → dark plain pants
            allowedColors = ['Black', 'Charcoal', 'Navy Blue', 'Navy'];
            break;
        case 'striped':
            // Striped shirt → neutral pants
            allowedColors = ['Beige', 'Khaki', 'Grey', 'Black', 'White', 'Navy Blue'];
            break;
        default:
            allowedColors = ['Black']; // Fallback
    }

    return allowedColors;
}
