import supabase from '../utils/supabaseClient.js';

/**
 * Utility function to apply fashion rules.
 * Determines matching pant colors based on the shirt's pattern.
 * 
 * @param {string} shirtPattern - The pattern of the shirt (e.g., 'plain', 'checked')
 * @returns {Array<string>} - An array of matching colors for the pants
 */
const getMatchingPantColors = (shirtPattern) => {
    switch (shirtPattern) {
        case 'plain':
            return ['Navy', 'Navy Blue', 'Black'];
        case 'checked':
            return ['Black', 'Grey'];
        case 'striped':
            return ['Black', 'Beige'];
        case 'printed':
            return ['Black'];
        default:
            // Safe fallback
            return ['Black'];
    }
};

/**
 * Express API Route Controller: Fetch a shirt and its matching pants
 * Accepts a query parameter: ?code=S-001
 */
export const getOutfitMatches = async (req, res) => {
    try {
        const { code } = req.query;
        console.log('Incoming code:', code);

        // Validation for missing code parameter
        if (!code) {
            return res.status(400).json({ error: 'Product code is required in the query parameter.' });
        }

        // Format the code: remove extra spaces and replace internal spaces with a hyphen
        // so if the user types URL?code=S 001, it correctly becomes 'S-001'
        const formattedCode = code.trim().replace(/\s+/g, '-');
        console.log('Formatted code searching for:', formattedCode);

        // 1. Fetch the exact product (shirt) from Supabase
        const { data: shirt, error: shirtError } = await supabase
            .from('products')
            .select('*')
            .ilike('code', formattedCode)
            .single();

        // 2. Handle Database errors or Not Found
        if (shirtError) {
            console.error("Supabase Connection Error:", shirtError);
            return res.status(500).json({ error: `Supabase Error: ${shirtError.message || 'Fetch failed. Your Supabase project might be paused or offline.'}` });
        }
        if (!shirt) {
            return res.status(404).json({ error: `Product with code '${code}' not found in the database.` });
        }

        // Stop processing if it's not a shirt
        if (shirt.category !== 'shirt') {
            return res.status(200).json({
                shirt: shirt,
                matches: [],
                message: "No matching rules applied since the item is not a shirt."
            });
        }

        // 3. Based on shirt.pattern, determine pants colors
        const allowedColors = getMatchingPantColors(shirt.pattern);

        // 4. Fetch the matching pants from Supabase
        const { data: matchingPants, error: pantsError } = await supabase
            .from('products')
            .select('*')
            .eq('category', 'pant')
            .in('color', allowedColors);

        if (pantsError) {
            throw new Error(pantsError.message); // Will be caught by the outer catch block
        }

        // 5. Return the finalized JSON structure
        return res.status(200).json({
            shirt: shirt,
            matches: matchingPants || []
        });

    } catch (error) {
        // 6. Handle internal server errors (500)
        console.error('API Error in getOutfitMatches:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
};
