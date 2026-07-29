import {
  LayoutDashboard,
  MessageSquare,
  ShoppingBag,
  Receipt,
  Package,
  Settings,
  MonitorPlay,
} from 'lucide-react';

export const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/chats', icon: MessageSquare, label: 'Chats' },
  { to: '/orders', icon: ShoppingBag, label: 'Orders' },
  { to: '/billing', icon: Receipt, label: 'Billing' },
  { to: '/products', icon: Package, label: 'Products' },
  { to: '/demo-manager', icon: MonitorPlay, label: 'Demo Manager' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];
