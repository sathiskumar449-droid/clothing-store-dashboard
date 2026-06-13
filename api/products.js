import fs from 'fs';

const PRODUCTS_FILE = './database/products.json';


// ✅ Get all products
export const getProducts = async (req, res) => {
    try {

        if (!fs.existsSync(PRODUCTS_FILE)) {
            fs.writeFileSync(PRODUCTS_FILE, '[]');
        }

        const data = fs.readFileSync(PRODUCTS_FILE, 'utf8');

        const products = JSON.parse(data);

        res.json(products);

    } catch (error) {

        console.error('❌ Get Products Error:', error);

        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};


// ✅ Add product
export const addProduct = async (req, res) => {

    try {

        const product = req.body;

        console.log('📦 Incoming Product:', product);

        if (!product.name) {
            return res.status(400).json({
                success: false,
                message: 'Product name required'
            });
        }

        // create file if missing
        if (!fs.existsSync(PRODUCTS_FILE)) {
            fs.writeFileSync(PRODUCTS_FILE, '[]');
        }

        // read old products
        const data = fs.readFileSync(PRODUCTS_FILE, 'utf8');

        const products = JSON.parse(data);

        // add id
        product.id = Date.now();

        // push
        products.push(product);

        // save
        fs.writeFileSync(
            PRODUCTS_FILE,
            JSON.stringify(products, null, 2)
        );

        console.log('✅ Product Saved');

        res.json({
            success: true,
            message: 'Product added successfully',
            product
        });

    } catch (error) {

        console.error('❌ Add Product Error:', error);

        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// ✅ Update product
export const updateProduct = async (req, res) => {
    try {
        const productId = req.params.id;
        const updates = req.body;
        
        if (!fs.existsSync(PRODUCTS_FILE)) {
            return res.status(404).json({ success: false, message: 'Products file not found' });
        }

        const data = fs.readFileSync(PRODUCTS_FILE, 'utf8');
        let products = JSON.parse(data);
        
        const index = products.findIndex(p => p.id == productId);
        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        products[index] = { ...products[index], ...updates };
        
        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
        
        res.json({ success: true, message: 'Product updated successfully', product: products[index] });
    } catch (error) {
        console.error('❌ Update Product Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ✅ Delete product
export const deleteProduct = async (req, res) => {
    try {
        const productId = req.params.id;
        
        if (!fs.existsSync(PRODUCTS_FILE)) {
            return res.status(404).json({ success: false, message: 'Products file not found' });
        }

        const data = fs.readFileSync(PRODUCTS_FILE, 'utf8');
        let products = JSON.parse(data);
        
        const initialLength = products.length;
        products = products.filter(p => p.id != productId);
        
        if (products.length === initialLength) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
        
        res.json({ success: true, message: 'Product deleted successfully' });
    } catch (error) {
        console.error('❌ Delete Product Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};