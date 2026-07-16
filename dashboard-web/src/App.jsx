import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import DashboardPasswordGate from './components/DashboardPasswordGate';
import DashboardPage from './pages/DashboardPage';
import ChatsPage from './pages/ChatsPage';
import OrdersPage from './pages/OrdersPage';
import BillingPage from './pages/BillingPage';
import ProductsPage from './pages/ProductsPage';
import CustomersPage from './pages/CustomersPage';
import SettingsPage from './pages/SettingsPage';
import DemoManager from './components/DemoManager';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route
            path="dashboard"
            element={
              <DashboardPasswordGate>
                <DashboardPage />
              </DashboardPasswordGate>
            }
          />
          <Route path="chats" element={<ChatsPage />} />
          <Route path="chats/:phone" element={<ChatsPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="products" element={<ProductsPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="demo-manager" element={<DemoManager />} />
          <Route
            path="settings"
            element={
              <DashboardPasswordGate>
                <SettingsPage />
              </DashboardPasswordGate>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
