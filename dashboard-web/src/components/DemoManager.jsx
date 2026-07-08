import { useState, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  Store,
  Plus,
  Trash2,
  Copy,
  Check,
  CheckCircle,
  AlertCircle,
  Upload,
  Package,
  Phone,
  MessageSquare,
  Loader2,
  ImageOff,
} from "lucide-react";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

const STORAGE_BUCKET = "demo-products";

const inputCls = "w-full px-3.5 py-2.5 min-h-11 text-sm rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition";

function Section({ title, icon: Icon, children }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 md:p-6">
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
        <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
          <Icon size={16} className="text-indigo-600" />
        </div>
        <h2 className="text-sm font-bold text-gray-800">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Field({ label, id, children }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-gray-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

export default function DemoManager() {
  const [shops, setShops] = useState([]);
  const [loadingShops, setLoadingShops] = useState(true);
  const [shopsError, setShopsError] = useState("");

  const [selectedShopId, setSelectedShopId] = useState(null);
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productsError, setProductsError] = useState("");

  const [toast, setToast] = useState(null);

  const [shopName, setShopName] = useState("");
  const [demoCode, setDemoCode] = useState("");
  const [ownerWhatsapp, setOwnerWhatsapp] = useState("");
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const [creatingShop, setCreatingShop] = useState(false);

  const [productName, setProductName] = useState("");
  const [productPrice, setProductPrice] = useState("");
  const [productCategory, setProductCategory] = useState("");
  const [productSizes, setProductSizes] = useState("");
  const [productImageFile, setProductImageFile] = useState(null);
  const [addingProduct, setAddingProduct] = useState(false);

  const [deletingShopId, setDeletingShopId] = useState(null);
  const [deletingProductId, setDeletingProductId] = useState(null);
  const [copiedShopId, setCopiedShopId] = useState(null);

  const showToast = (type, text) => {
    setToast({ type, text });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchShops = useCallback(async () => {
    setLoadingShops(true);
    setShopsError("");
    try {
      const { data, error } = await supabase
        .from("demo_shops")
        .select("*, demo_products(count)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setShops(
        (data || []).map((s) => ({
          ...s,
          product_count: s.demo_products?.[0]?.count ?? 0,
        }))
      );
    } catch (err) {
      setShopsError(err.message || "Failed to load demo shops.");
    } finally {
      setLoadingShops(false);
    }
  }, []);

  const fetchProducts = useCallback(async (shopId) => {
    if (!shopId) {
      setProducts([]);
      return;
    }
    setLoadingProducts(true);
    setProductsError("");
    try {
      const { data, error } = await supabase
        .from("demo_products")
        .select("*")
        .eq("demo_shop_id", shopId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      setProducts(data || []);
    } catch (err) {
      setProductsError(err.message || "Failed to load products.");
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  useEffect(() => {
    fetchShops();
  }, [fetchShops]);

  useEffect(() => {
    fetchProducts(selectedShopId);
  }, [selectedShopId, fetchProducts]);

  const selectedShop = shops.find((s) => s.id === selectedShopId) || null;

  const handleCreateShop = async (e) => {
    e.preventDefault();
    const name = shopName.trim();
    const code = demoCode.trim().toUpperCase();
    if (!name || !code) {
      showToast("error", "Shop name and demo code are required.");
      return;
    }
    setCreatingShop(true);
    try {
      const { data: existing, error: checkError } = await supabase
        .from("demo_shops")
        .select("id")
        .eq("demo_code", code)
        .maybeSingle();
      if (checkError) throw checkError;
      if (existing) {
        showToast("error", `Demo code "${code}" is already in use.`);
        return;
      }

      const { data, error } = await supabase
        .from("demo_shops")
        .insert({
          shop_name: name,
          demo_code: code,
          owner_whatsapp: ownerWhatsapp.trim() || null,
          welcome_message: welcomeMessage.trim() || null,
        })
        .select()
        .single();
      if (error) throw error;

      setShops((prev) => [{ ...data, product_count: 0 }, ...prev]);
      setSelectedShopId(data.id);
      setShopName("");
      setDemoCode("");
      setOwnerWhatsapp("");
      setWelcomeMessage("");
      showToast("success", `Demo shop "${name}" created.`);
    } catch (err) {
      showToast("error", err.message || "Failed to create demo shop.");
    } finally {
      setCreatingShop(false);
    }
  };

  const handleDeleteShop = async (shop) => {
    if (!window.confirm(`Delete demo shop "${shop.shop_name}" and all its products? This cannot be undone.`)) return;
    setDeletingShopId(shop.id);
    try {
      const { error: productsDeleteError } = await supabase
        .from("demo_products")
        .delete()
        .eq("demo_shop_id", shop.id);
      if (productsDeleteError) throw productsDeleteError;

      const { error } = await supabase.from("demo_shops").delete().eq("id", shop.id);
      if (error) throw error;

      setShops((prev) => prev.filter((s) => s.id !== shop.id));
      if (selectedShopId === shop.id) {
        setSelectedShopId(null);
        setProducts([]);
      }
      showToast("success", `Deleted "${shop.shop_name}".`);
    } catch (err) {
      showToast("error", err.message || "Failed to delete demo shop.");
    } finally {
      setDeletingShopId(null);
    }
  };

  const handleCopyCommand = async (shop) => {
    try {
      await navigator.clipboard.writeText(`demo ${shop.demo_code}`);
      setCopiedShopId(shop.id);
      setTimeout(() => setCopiedShopId(null), 2000);
    } catch {
      showToast("error", "Could not copy to clipboard.");
    }
  };

  const handleAddProduct = async (e) => {
    e.preventDefault();
    if (!selectedShopId) return;
    const name = productName.trim();
    const price = parseFloat(productPrice);
    if (!name || isNaN(price)) {
      showToast("error", "Product name and a valid price are required.");
      return;
    }
    setAddingProduct(true);
    const formEl = e.target;
    try {
      let imageUrl = null;
      if (productImageFile) {
        const ext = productImageFile.name.split(".").pop();
        const path = `${selectedShopId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, productImageFile);
        if (uploadError) throw uploadError;
        const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
        imageUrl = urlData.publicUrl;
      }

      const sizes = productSizes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const { data, error } = await supabase
        .from("demo_products")
        .insert({
          demo_shop_id: selectedShopId,
          name,
          price,
          image_url: imageUrl,
          category: productCategory.trim() || null,
          sizes,
        })
        .select()
        .single();
      if (error) throw error;

      setProducts((prev) => [data, ...prev]);
      setShops((prev) =>
        prev.map((s) => (s.id === selectedShopId ? { ...s, product_count: s.product_count + 1 } : s))
      );
      setProductName("");
      setProductPrice("");
      setProductCategory("");
      setProductSizes("");
      setProductImageFile(null);
      formEl.reset();
      showToast("success", `Added "${name}".`);
    } catch (err) {
      showToast("error", err.message || "Failed to add product.");
    } finally {
      setAddingProduct(false);
    }
  };

  const handleDeleteProduct = async (product) => {
    if (!window.confirm(`Delete "${product.name}"?`)) return;
    setDeletingProductId(product.id);
    try {
      const { error } = await supabase.from("demo_products").delete().eq("id", product.id);
      if (error) throw error;
      setProducts((prev) => prev.filter((p) => p.id !== product.id));
      setShops((prev) =>
        prev.map((s) =>
          s.id === selectedShopId ? { ...s, product_count: Math.max(0, s.product_count - 1) } : s
        )
      );
    } catch (err) {
      showToast("error", err.message || "Failed to delete product.");
    } finally {
      setDeletingProductId(null);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Demo Manager</h1>
        <p className="text-sm text-gray-500 mt-0.5">Create personalized demo shops to show prospects a live WhatsApp bot demo</p>
      </div>

      {toast && (
        <div
          className={`flex items-start gap-3 rounded-xl p-4 mb-6 border ${
            toast.type === "success" ? "bg-emerald-50 border-emerald-200" : "bg-rose-50 border-rose-200"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle size={18} className="text-emerald-500 shrink-0 mt-0.5" />
          ) : (
            <AlertCircle size={18} className="text-rose-500 shrink-0 mt-0.5" />
          )}
          <p className={`text-sm ${toast.type === "success" ? "text-emerald-700" : "text-rose-600"}`}>{toast.text}</p>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Left column: create shop + shops list */}
        <div className="w-full lg:w-96 shrink-0 space-y-6">
          <Section title="Create Demo Shop" icon={Plus}>
            <form onSubmit={handleCreateShop} className="space-y-4">
              <Field label="Shop Name" id="shop-name">
                <input
                  id="shop-name"
                  type="text"
                  className={inputCls}
                  placeholder="e.g. Raja Textiles"
                  value={shopName}
                  onChange={(e) => setShopName(e.target.value)}
                />
              </Field>
              <Field label="Demo Code" id="demo-code">
                <input
                  id="demo-code"
                  type="text"
                  className={`${inputCls} font-mono`}
                  placeholder="e.g. RAJA01"
                  value={demoCode}
                  onChange={(e) => setDemoCode(e.target.value.toUpperCase())}
                />
              </Field>
              <Field label="Owner WhatsApp (optional)" id="owner-whatsapp">
                <div className="relative">
                  <Phone size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    id="owner-whatsapp"
                    type="text"
                    className={`${inputCls} pl-9`}
                    placeholder="+91 99999 99999"
                    value={ownerWhatsapp}
                    onChange={(e) => setOwnerWhatsapp(e.target.value)}
                  />
                </div>
              </Field>
              <Field label="Welcome Message (optional)" id="welcome-message">
                <div className="relative">
                  <MessageSquare size={14} className="absolute left-3 top-3 text-gray-400" />
                  <textarea
                    id="welcome-message"
                    rows={3}
                    className={`${inputCls} pl-9 resize-none`}
                    placeholder="Hello! Welcome to..."
                    value={welcomeMessage}
                    onChange={(e) => setWelcomeMessage(e.target.value)}
                  />
                </div>
              </Field>
              <button
                type="submit"
                disabled={creatingShop}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 min-h-11 rounded-xl text-sm font-semibold transition-all duration-300 ease-in-out active:scale-95 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
              >
                {creatingShop ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                {creatingShop ? "Creating..." : "Create Shop"}
              </button>
            </form>
          </Section>

          <Section title="Demo Shops" icon={Store}>
            {loadingShops ? (
              <p className="text-sm text-gray-400">Loading...</p>
            ) : shopsError ? (
              <p className="text-xs text-rose-600">{shopsError}</p>
            ) : shops.length === 0 ? (
              <p className="text-sm text-gray-400">No demo shops yet. Create one above.</p>
            ) : (
              <div className="space-y-2">
                {shops.map((shop) => (
                  <div
                    key={shop.id}
                    onClick={() => setSelectedShopId(shop.id)}
                    className={`p-3 rounded-xl border cursor-pointer transition-colors ${
                      selectedShopId === shop.id ? "bg-indigo-50 border-indigo-200" : "border-gray-100 hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-800 truncate">{shop.shop_name}</p>
                        <p className="text-xs font-mono text-indigo-600 mt-0.5">{shop.demo_code}</p>
                        <p className="text-[11px] text-gray-400 mt-1">
                          {shop.product_count} product{shop.product_count !== 1 ? "s" : ""}
                        </p>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteShop(shop);
                        }}
                        disabled={deletingShopId === shop.id}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition-colors shrink-0 disabled:opacity-50"
                        title="Delete shop"
                      >
                        {deletingShopId === shop.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCopyCommand(shop);
                      }}
                      className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-gray-500 hover:text-indigo-600 transition-colors"
                    >
                      {copiedShopId === shop.id ? (
                        <Check size={12} className="text-emerald-600" />
                      ) : (
                        <Copy size={12} />
                      )}
                      {copiedShopId === shop.id ? "Copied!" : "Copy Demo Command"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* Right column: selected shop's products */}
        <div className="flex-1 w-full space-y-6">
          {!selectedShop ? (
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center">
              <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-4">
                <Store size={28} className="text-indigo-400" />
              </div>
              <h3 className="text-base font-semibold text-gray-700 mb-1">No shop selected</h3>
              <p className="text-sm text-gray-400 max-w-sm mx-auto">
                Select a demo shop on the left, or create a new one, to manage its products.
              </p>
            </div>
          ) : (
            <>
              <Section title={`Add Product to "${selectedShop.shop_name}"`} icon={Package}>
                <form onSubmit={handleAddProduct} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="Product Name" id="product-name">
                      <input
                        id="product-name"
                        type="text"
                        className={inputCls}
                        placeholder="e.g. Cotton Kurta"
                        value={productName}
                        onChange={(e) => setProductName(e.target.value)}
                      />
                    </Field>
                    <Field label="Price" id="product-price">
                      <input
                        id="product-price"
                        type="number"
                        step="0.01"
                        className={inputCls}
                        placeholder="e.g. 899"
                        value={productPrice}
                        onChange={(e) => setProductPrice(e.target.value)}
                      />
                    </Field>
                    <Field label="Category" id="product-category">
                      <input
                        id="product-category"
                        type="text"
                        className={inputCls}
                        placeholder="e.g. Shirts"
                        value={productCategory}
                        onChange={(e) => setProductCategory(e.target.value)}
                      />
                    </Field>
                    <Field label="Sizes (comma-separated)" id="product-sizes">
                      <input
                        id="product-sizes"
                        type="text"
                        className={inputCls}
                        placeholder="e.g. S, M, L, XL"
                        value={productSizes}
                        onChange={(e) => setProductSizes(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Field label="Product Photo" id="product-image">
                    <div className="relative">
                      <Upload size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      <input
                        id="product-image"
                        type="file"
                        accept="image/*"
                        className={`${inputCls} pl-9 pt-2`}
                        onChange={(e) => setProductImageFile(e.target.files?.[0] || null)}
                      />
                    </div>
                  </Field>
                  <button
                    type="submit"
                    disabled={addingProduct}
                    className="w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2.5 min-h-11 rounded-xl text-sm font-semibold transition-all duration-300 ease-in-out active:scale-95 bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
                  >
                    {addingProduct ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                    {addingProduct ? "Uploading..." : "Add Product"}
                  </button>
                </form>
              </Section>

              <Section title={`${selectedShop.shop_name} Products`} icon={Package}>
                {loadingProducts ? (
                  <p className="text-sm text-gray-400">Loading...</p>
                ) : productsError ? (
                  <p className="text-xs text-rose-600">{productsError}</p>
                ) : products.length === 0 ? (
                  <p className="text-sm text-gray-400">No products added yet.</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                    {products.map((product) => (
                      <div key={product.id} className="rounded-xl border border-gray-100 overflow-hidden group relative">
                        <div className="aspect-square bg-gray-50 flex items-center justify-center overflow-hidden">
                          {product.image_url ? (
                            <img
                              src={product.image_url}
                              alt={product.name}
                              loading="lazy"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <ImageOff size={24} className="text-gray-200" />
                          )}
                        </div>
                        <div className="p-2.5">
                          <p className="text-xs font-bold text-gray-800 truncate">{product.name}</p>
                          <p className="text-xs font-semibold text-indigo-700 mt-0.5">
                            ₹{parseFloat(product.price).toLocaleString("en-IN")}
                          </p>
                        </div>
                        <button
                          onClick={() => handleDeleteProduct(product)}
                          disabled={deletingProductId === product.id}
                          className="absolute top-2 right-2 p-1.5 rounded-lg bg-white/90 text-gray-500 hover:text-rose-600 shadow-sm transition-colors disabled:opacity-50"
                          title="Delete product"
                        >
                          {deletingProductId === product.id ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Trash2 size={13} />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
