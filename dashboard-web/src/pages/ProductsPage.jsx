import { useState, useCallback, useEffect, useMemo } from 'react';
import { Package, RefreshCw, AlertCircle, ExternalLink, CheckCircle, Search, Filter, X, Grid, ChevronLeft, ChevronRight } from 'lucide-react';
import { getWooProducts, syncWooProductsToDb } from '../api/productsApi';
import api from '../api/axiosInstance';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';

const PAGE_SIZE = 24;

export default function ProductsPage() {
  // Displayed products always come from our own DB (/api/products) — fast, since it's a
  // single local Supabase query instead of paginated live calls to the WooCommerce REST API.
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);
  const [syncError, setSyncError] = useState(null);

  // Search and Category filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  const [page, setPage] = useState(1);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/products');
      setProducts(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Reading the WooCommerce store's live products is only needed for the explicit "Sync"
  // action below, not for every page load — pulls saved settings from localStorage, falling
  // back to the backend (and caching the result) the same way the old auto-fetch-on-mount did.
  const ensureWooSettingsLoaded = async () => {
    const raw = localStorage.getItem('woo_settings');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.siteUrl && parsed.consumerKey && parsed.consumerSecret) return true;
      } catch {
        // fall through to refetch from the backend
      }
    }
    const response = await api.get('/settings/woo');
    if (response.data?.siteUrl && response.data?.consumerKey && response.data?.consumerSecret) {
      localStorage.setItem('woo_settings', JSON.stringify(response.data));
      return true;
    }
    return false;
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const hasSettings = await ensureWooSettingsLoaded();
      if (!hasSettings) {
        throw new Error('WooCommerce settings not configured. Please go to Settings.');
      }
      const wooProducts = await getWooProducts();
      const result = await syncWooProductsToDb(wooProducts);
      if (result.success) {
        setSyncMessage(result.message || `Successfully synced ${wooProducts.length} products to database!`);
        await fetchProducts();
      } else {
        throw new Error(result.message || 'Sync failed');
      }
    } catch (err) {
      setSyncError(err.message || 'Failed to sync products to database');
    } finally {
      setSyncing(false);
    }
  };

  const formatPrice = (price) => {
    if (!price) return '—';
    return `₹${parseFloat(price).toLocaleString('en-IN')}`;
  };

  // The DB only stores one flat category string per product (see getPrimaryCategory() in
  // api/products.js), not WooCommerce's full parent/child category tree, so the sidebar is a
  // flat, alphabetised list of distinct categories with counts rather than a nested tree.
  const categories = useMemo(() => {
    const counts = {};
    products.forEach(p => {
      const cat = p.category || 'Uncategorized';
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products]);

  const filteredProducts = useMemo(() => {
    return products.filter(product => {
      const matchesCategory = !selectedCategory || (product.category || 'Uncategorized') === selectedCategory;
      let matchesSearch = true;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        matchesSearch =
          product.name?.toLowerCase().includes(q) ||
          (product.code && product.code.toLowerCase().includes(q)) ||
          (product.id && String(product.id).includes(q)) ||
          (product.category && product.category.toLowerCase().includes(q));
      }
      return matchesCategory && matchesSearch;
    });
  }, [products, selectedCategory, searchQuery]);

  // Reset to page 1 whenever the filtered set changes shape, so you don't land on an empty
  // page 4 after a search/category change shrinks the results.
  useEffect(() => {
    setPage(1);
  }, [searchQuery, selectedCategory]);

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));

  // Renders one page (24 cards) at a time instead of all 171 at once — keeps the number of
  // <img> tags mounted (and decoding) at any given moment small.
  const pagedProducts = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredProducts.slice(start, start + PAGE_SIZE);
  }, [filteredProducts, page]);

  const renderCategoryList = (onSelect = null) => (
    <div className="space-y-1">
      <div
        className={`flex items-center gap-2 py-1.5 px-2 rounded-xl cursor-pointer transition-colors ${
          !selectedCategory
            ? 'bg-indigo-50 text-indigo-700 font-semibold'
            : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
        }`}
        onClick={() => { setSelectedCategory(''); if (onSelect) onSelect(); }}
      >
        <Grid size={12} className={!selectedCategory ? 'text-indigo-600' : 'text-gray-400'} />
        <span className="text-xs">All Products</span>
        <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full ml-auto font-medium">
          {products.length}
        </span>
      </div>
      {categories.map(cat => {
        const isSelected = selectedCategory === cat.name;
        return (
          <div
            key={cat.name}
            className={`flex items-center justify-between py-1.5 px-2 rounded-xl cursor-pointer transition-all ${
              isSelected
                ? 'bg-indigo-50 text-indigo-700 font-semibold border-l-4 border-indigo-600 pl-1.5'
                : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 pl-2'
            }`}
            onClick={() => { setSelectedCategory(isSelected ? '' : cat.name); if (onSelect) onSelect(); }}
          >
            <span className="text-xs truncate flex-1 leading-none">{cat.name}</span>
            <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full font-medium ml-2 shrink-0">
              {cat.count}
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          <p className="text-sm text-gray-500 mt-0.5">Your synced product catalog</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleSync}
            disabled={syncing || loading}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-60 shadow-sm transition-colors cursor-pointer"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Syncing...' : 'Sync from WooCommerce'}
          </button>
          <button
            onClick={fetchProducts}
            disabled={loading || syncing}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-60 shadow-sm transition-colors cursor-pointer"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {syncMessage && (
        <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-6">
          <CheckCircle size={18} className="text-emerald-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-emerald-700">Sync Successful</p>
            <p className="text-xs text-emerald-600 mt-0.5">{syncMessage}</p>
          </div>
        </div>
      )}

      {syncError && (
        <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-xl p-4 mb-6">
          <AlertCircle size={18} className="text-rose-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-rose-700">Sync Error</p>
            <p className="text-xs text-rose-600 mt-0.5">{syncError}</p>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-xl p-4 mb-6">
          <AlertCircle size={18} className="text-rose-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-rose-700">Failed to load products</p>
            <p className="text-xs text-rose-600 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {loading ? (
        <Loader text="Loading products..." />
      ) : products.length === 0 && !error ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center max-w-xl mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-4">
            <Package size={28} className="text-indigo-400" />
          </div>
          <h3 className="text-base font-semibold text-gray-700 mb-1">No products yet</h3>
          <p className="text-sm text-gray-400 max-w-sm mx-auto mb-4 leading-relaxed">
            Your catalog is empty. Click "Sync from WooCommerce" to pull your live inventory in.
            Make sure you've added your store URL and API keys in Settings.
          </p>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 shadow-sm transition-colors cursor-pointer disabled:opacity-60"
          >
            {syncing ? 'Syncing...' : 'Sync from WooCommerce'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col md:flex-row gap-6 items-start">
          <aside className="hidden md:block w-64 shrink-0 bg-white rounded-2xl border border-gray-100 shadow-sm p-4 sticky top-4 max-h-[calc(100vh-6rem)] overflow-y-auto">
            <div className="relative mb-5">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-8 py-2 text-xs rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-gray-50/50"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 cursor-pointer"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="flex items-center justify-between mb-3 px-1">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Categories</span>
              {selectedCategory && (
                <button
                  onClick={() => setSelectedCategory('')}
                  className="text-[10px] font-semibold text-indigo-600 hover:text-indigo-800 transition-colors cursor-pointer"
                >
                  Clear filter
                </button>
              )}
            </div>
            {renderCategoryList()}
          </aside>

          <div className="md:hidden flex gap-2 w-full mb-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-8 py-2.5 text-xs rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white shadow-sm"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <button
              onClick={() => setIsFilterDrawerOpen(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-white border border-gray-200 text-gray-700 text-xs font-semibold hover:bg-gray-50 shadow-sm shrink-0 transition-colors cursor-pointer"
            >
              <Filter size={14} className={selectedCategory ? 'text-indigo-600' : 'text-gray-400'} />
              <span>Filter</span>
              {selectedCategory && (
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-600" />
              )}
            </button>
          </div>

          {isFilterDrawerOpen && (
            <div className="fixed inset-0 z-50 flex md:hidden">
              <div
                className="fixed inset-0 bg-black/40 transition-opacity"
                onClick={() => setIsFilterDrawerOpen(false)}
              />
              <div className="relative flex flex-col w-72 max-w-sm bg-white h-full shadow-2xl p-4 overflow-y-auto ml-auto">
                <div className="flex items-center justify-between pb-3 border-b border-gray-100 mb-4">
                  <span className="text-sm font-bold text-gray-800">Categories</span>
                  <button
                    onClick={() => setIsFilterDrawerOpen(false)}
                    className="p-1 rounded-full hover:bg-gray-100 text-gray-500 hover:text-gray-700"
                  >
                    <X size={16} />
                  </button>
                </div>
                {renderCategoryList(() => setIsFilterDrawerOpen(false))}
              </div>
            </div>
          )}

          <div className="flex-1 w-full">
            {(selectedCategory || searchQuery) && (
              <div className="flex flex-wrap items-center gap-2 mb-4 bg-white border border-gray-100 rounded-2xl p-3 shadow-sm">
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">Filters:</span>
                {selectedCategory && (
                  <span className="flex items-center gap-1.5 bg-indigo-50 text-indigo-700 text-xs px-3 py-1 rounded-full font-medium shadow-sm">
                    Category: {selectedCategory}
                    <button
                      onClick={() => setSelectedCategory('')}
                      className="hover:bg-indigo-100 rounded-full p-0.5 transition-colors cursor-pointer"
                    >
                      <X size={10} />
                    </button>
                  </span>
                )}
                {searchQuery && (
                  <span className="flex items-center gap-1.5 bg-indigo-50 text-indigo-700 text-xs px-3 py-1 rounded-full font-medium shadow-sm">
                    Search: "{searchQuery}"
                    <button
                      onClick={() => setSearchQuery('')}
                      className="hover:bg-indigo-100 rounded-full p-0.5 transition-colors cursor-pointer"
                    >
                      <X size={10} />
                    </button>
                  </span>
                )}
                <button
                  onClick={() => {
                    setSelectedCategory('');
                    setSearchQuery('');
                  }}
                  className="text-xs text-indigo-600 hover:text-indigo-800 font-bold ml-auto mr-1 transition-colors cursor-pointer"
                >
                  Clear All
                </button>
              </div>
            )}

            <p className="text-xs text-gray-500 mb-4 ml-1">
              {filteredProducts.length === products.length ? (
                <>Found {products.length} product{products.length !== 1 ? 's' : ''}</>
              ) : (
                <>Showing {filteredProducts.length} of {products.length} product{products.length !== 1 ? 's' : ''} after filtering</>
              )}
            </p>

            {filteredProducts.length === 0 ? (
              <EmptyState
                icon={Package}
                title="No products match your filters"
                description="Try clearing your search query or choosing a different category to see products."
              />
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {pagedProducts.map(product => {
                    const inStock = parseInt(product.stock, 10) > 0;
                    return (
                      <div key={product.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow group flex flex-col justify-between">
                        <div>
                          <div className="aspect-square bg-gray-50 overflow-hidden relative">
                            {product.imageUri ? (
                              <img
                                src={product.imageUri}
                                alt={product.name}
                                loading="lazy"
                                decoding="async"
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Package size={32} className="text-gray-200" />
                              </div>
                            )}
                          </div>
                          <div className="p-3 pb-1">
                            <p className="text-xs font-bold text-gray-800 line-clamp-2 leading-tight min-h-[2rem]">
                              {product.name}
                            </p>
                            <div className="flex items-center justify-between mt-2">
                              <span className="text-sm font-bold text-indigo-700">{formatPrice(product.price)}</span>
                              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${inStock ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600'}`}>
                                {inStock ? 'In Stock' : 'Out'}
                              </span>
                            </div>
                            {product.category && (
                              <p className="text-[10px] text-gray-400 mt-2 truncate font-medium">
                                {product.category}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="p-3 pt-0 mt-1">
                          {product.permalink && (
                            <a
                              href={product.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg border border-indigo-50 hover:bg-indigo-50 text-[10px] font-semibold text-indigo-600 hover:text-indigo-700 transition-colors"
                            >
                              <ExternalLink size={10} /> View on store
                            </a>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-3 mt-6">
                    <button
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="flex items-center gap-1 px-3 py-2 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <ChevronLeft size={14} /> Prev
                    </button>
                    <span className="text-xs text-gray-500 font-medium">
                      Page {page} of {totalPages}
                    </span>
                    <button
                      onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="flex items-center gap-1 px-3 py-2 rounded-xl border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      Next <ChevronRight size={14} />
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
