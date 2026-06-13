-- 1. Create the Products Table
CREATE TABLE products (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT CHECK (category IN ('shirt', 'pant')),
    pattern TEXT CHECK (pattern IN ('plain', 'checked', 'striped', 'printed')),
    color TEXT,
    price INTEGER,
    size TEXT,
    stock INTEGER,
    image_url TEXT
);

-- 2. Insert Sample Data
INSERT INTO products (code, name, category, pattern, color, price, size, stock, image_url) 
VALUES 
    -- 5 Sample Shirts
    ('S-001', 'Classic White Plain Shirt', 'shirt', 'plain', 'White', 599, 'M', 50, 'https://example.com/images/s001.jpg'),
    ('S-002', 'Navy Blue Checked Casual Shirt', 'shirt', 'checked', 'Navy Blue', 699, 'L', 30, 'https://example.com/images/s002.jpg'),
    ('S-003', 'Grey Striped Formal Shirt', 'shirt', 'striped', 'Grey', 749, 'M', 45, 'https://example.com/images/s003.jpg'),
    ('S-004', 'Beige Printed Resort Shirt', 'shirt', 'printed', 'Beige', 799, 'XL', 20, 'https://example.com/images/s004.jpg'),
    ('S-005', 'Black Plain Slim Fit Shirt', 'shirt', 'plain', 'Black', 649, 'L', 60, 'https://example.com/images/s005.jpg'),

    -- 5 Sample Matching Pants
    ('P-001', 'Classic White Plain Trousers', 'pant', 'plain', 'White', 899, '32', 40, 'https://example.com/images/p001.jpg'),
    ('P-002', 'Navy Blue Checked Chinos', 'pant', 'checked', 'Navy Blue', 999, '34', 25, 'https://example.com/images/p002.jpg'),
    ('P-003', 'Grey Striped Formal Trousers', 'pant', 'striped', 'Grey', 1049, '32', 35, 'https://example.com/images/p003.jpg'),
    ('P-004', 'Beige Printed Beach Pants', 'pant', 'printed', 'Beige', 849, '36', 15, 'https://example.com/images/p004.jpg'),
    ('P-005', 'Black Plain Flat Front Trousers', 'pant', 'plain', 'Black', 949, '34', 50, 'https://example.com/images/p005.jpg');

-- 3. Create Orders Table
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    customer_phone TEXT NOT NULL,
    product_code TEXT NOT NULL, 
    selected_pant TEXT,
    size TEXT NOT NULL,
    total_price INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Create Order Insertion Function
CREATE OR REPLACE FUNCTION create_new_order(
    p_customer_phone TEXT,
    p_product_code TEXT,
    p_selected_pant TEXT,
    p_size TEXT,
    p_total_price INTEGER
)
RETURNS INTEGER AS $$
DECLARE
    new_order_id INTEGER;
BEGIN
    INSERT INTO orders (
        customer_phone, 
        product_code, 
        selected_pant, 
        size, 
        total_price
    )
    VALUES (
        p_customer_phone, 
        p_product_code, 
        p_selected_pant, 
        p_size, 
        p_total_price
    )
    RETURNING id INTO new_order_id;
    
    RETURN new_order_id; 
END;
$$ LANGUAGE plpgsql;
