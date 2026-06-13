import fs from 'fs';

const ORDERS_FILE = './database/orders.json';

export const getOrders = async (req, res) => {
    try {
        if (!fs.existsSync(ORDERS_FILE)) {
            fs.writeFileSync(ORDERS_FILE, '[]');
        }
        const data = fs.readFileSync(ORDERS_FILE, 'utf8');
        const orders = JSON.parse(data);
        res.json(orders);
    } catch (error) {
        console.error('❌ Get Orders Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updateOrderStatus = async (req, res) => {
    try {
        const orderId = req.params.id;
        const { status } = req.body;
        
        if (!fs.existsSync(ORDERS_FILE)) {
            return res.status(404).json({ success: false, message: 'Orders file not found' });
        }

        const data = fs.readFileSync(ORDERS_FILE, 'utf8');
        let orders = JSON.parse(data);
        
        const index = orders.findIndex(o => o.id === orderId || o.orderId === orderId);
        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        orders[index].status = status;
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
        
        res.json({ success: true, message: 'Order status updated successfully', order: orders[index] });
    } catch (error) {
        console.error('❌ Update Order Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};
