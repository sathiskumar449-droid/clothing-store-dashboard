import { useState, useCallback, useEffect, useMemo } from 'react';
import { Package, RefreshCw, AlertCircle, ExternalLink, CheckCircle, Search, Filter, X, ChevronDown, ChevronRight, Grid } from 'lucide-react';
import { getWooProducts, syncWooProductsToDb } from '../api/productsApi';
import api from '../api/axiosInstance';
import Loader from '../components/ui/Loader';
import EmptyState from '../components/ui/EmptyState';

// WooCommerce store category parent-child mapping
const CATEGORY_PARENT_MAP = {
  'casual-pant': 'men',
  'casual-shirts': 'men',
  'cotton-shirts': 'men',
  'half-sleeve-shirts': 'men',
  'jeans-pant': 'men',
  'mens-callor-white-t-shirt': 'men',
  'party-wear-shirts': 'men',
  'plain-shirts': 'men',
  'polo-t-shirts': 'men',
  'printed-shirts': 'men',
  't-shirts': 'men',
  'track-pant': 'men',
  'round-neck-t-shirt': 't-shirts',
  'round-neck': 't-shirts',
};

export default function ProductsPage() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [fetched, setFetched] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState(null);
  const [syncError, setSyncError] = useState(null);

  // Search and Category filters state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategorySlug, setSelectedCategorySlug] = useState('');
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState({
    'men': true,
    't-shirts': true
  });

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSyncMessage(null);
    setSyncError(null);
    try {
      const data = await getWooProducts();
      setProducts(data);
      setFetched(true);
    } catch (err) {
      setError(err.message || 'Failed to fetch products');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const loadSettingsAndFetch = async () => {
      try {
        let raw = localStorage.getItem('woo_settings');
        let siteUrl, consumerKey, consumerSecret;
        
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            siteUrl = parsed.siteUrl;
            consumerKey = parsed.consumerKey;
            consumerSecret = parsed.consumerSecret;
          } catch (e) {
            console.error('Error parsing local storage woo_settings:', e);
          }
        }

        if (!siteUrl || !consumerKey || !consumerSecret) {
          const response = await api.get('/settings/woo');
          if (response.data && response.data.siteUrl) {
            siteUrl = response.data.siteUrl;
            consumerKey = response.data.consumerKey;
            consumerSecret = response.data.consumerSecret;
            localStorage.setItem('woo_settings', JSON.stringify(response.data));
          }
        }

        if (siteUrl && consumerKey && consumerSecret) {
          fetchProducts();
        }
      } catch (e) {
        console.error('Failed to load settings or fetch products:', e);
      }
    };
    loadSettingsAndFetch();
  }, [fetchProducts]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const result = await syncWooProductsToDb(products);
      if (result.success) {
        setSyncMessage(result.message || `Successfully synced ${products.length} products to database!`);
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

  const toggleCategoryExpand = (slug) => {
    setExpandedCategories(prev => ({
      ...prev,
      [slug]: !prev[slug]
    }));
  };

  const isProductInSelectedCategory = useCallback((product, selectedSlug) => {
    if (!selectedSlug) return true;
    
    return product.categories?.some(cat => {
      const slug = cat.slug?.toLowerCase();
      if (slug === selectedSlug) return true;
      
      let parentSlug = CATEGORY_PARENT_MAP[slug];
      while (parentSlug) {
        if (parentSlug === selectedSlug) return true;
        parentSlug = CATEGORY_PARENT_MAP[parentSlug];
      }
      return false;
    });
  }, []);

  const categoryTree = useMemo(() => {
    if (!products || products.length === 0) return [];

    const categoryMap = {};
    products.forEach(p => {
      p.categories?.forEach(cat => {
        const slug = cat.slug?.toLowerCase();
        if (!categoryMap[slug]) {
          categoryMap[slug] = {
            id: cat.id,
            name: cat.name,
            slug: slug,
            children: []
          };
        }
      });
    });

    const mainParents = ['men', 'kids', 'new-arrival', 't-shirts'];
    mainParents.forEach(slug => {
      if (!categoryMap[slug]) {
        categoryMap[slug] = {
          id: slug,
          name: slug === 'men' ? 'Men' : slug === 'kids' ? 'Kids' : slug === 'new-arrival' ? 'New Arrival' : 'T-Shirts',
          slug: slug,
          children: []
        };
      }
    });

    const roots = [];
    const childSlugs = new Set();
    Object.keys(categoryMap).forEach(slug => {
      const parentSlug = CATEGORY_PARENT_MAP[slug];
      if (parentSlug && categoryMap[parentSlug]) {
        categoryMap[parentSlug].children.push(categoryMap[slug]);
        childSlugs.add(slug);
      }
    });

    Object.keys(categoryMap).forEach(slug => {
      if (!childSlugs.has(slug)) {
        const parentSlug = CATEGORY_PARENT_MAP[slug];
        if (!parentSlug) {
          roots.push(categoryMap[slug]);
        }
      }
    });

    const calculateCounts = (node) => {
      const count = products.filter(p => isProductInSelectedCategory(p, node.slug)).length;
      node.totalCount = count;
      node.children.forEach(child => calculateCounts(child));
    };

    roots.forEach(root => calculateCounts(root));

    const filterEmptyNodes = (nodes) => {
      return nodes
        .map(node => {
          if (node.children && node.children.length > 0) {
            node.children = filterEmptyNodes(node.children);
          }
          return node;
        })
        .filter(node => node.totalCount > 0);
    };

    const activeTree = filterEmptyNodes(roots);
    activeTree.sort((a, b) => {
      const order = { 'men': 1, 't-shirts': 2, 'kids': 3, 'new-arrival': 4 };
      const orderA = order[a.slug] || 99;
      const orderB = order[b.slug] || 99;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });

    return activeTree;
  }, [products, isProductInSelectedCategory]);

  const getCategoryNameBySlug = (slug) => {
    if (slug === 'men') return 'Men';
    if (slug === 'kids') return 'Kids';
    if (slug === 'new-arrival') return 'New Arrival';
    if (slug === 't-shirts') return 'T-Shirts';
    
    for (const p of products) {
      const found = p.categories?.find(c => c.slug?.toLowerCase() === slug);
      if (found) return found.name;
    }
    return slug;
  };

  const filteredProducts = useMemo(() => {
    return products.filter(product => {
      const matchesCategory = isProductInSelectedCategory(product, selectedCategorySlug);
      let matchesSearch = true;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        matchesSearch = 
          product.name?.toLowerCase().includes(q) ||
          (product.sku && product.sku.toLowerCase().includes(q)) ||
          (product.id && String(product.id).includes(q)) ||
          product.categories?.some(c => c.name?.toLowerCase().includes(q));
      }
      return matchesCategory && matchesSearch;
    });
  }, [products, selectedCategorySlug, searchQuery, isProductInSelectedCategory]);

  const renderCategoryItem = (node, depth = 0, onSelect = null) => {
    const isSelected = selectedCategorySlug === node.slug;
    const hasChildren = node.children && node.children.length > 0;
    const isExpanded = expandedCategories[node.slug];

    return (
      <div key={node.slug} className="select-none">
        <div 
          className={`flex items-center justify-between py-1.5 px-2 rounded-xl cursor-pointer transition-all ${
            isSelected 
              ? 'bg-indigo-50 text-indigo-700 font-semibold border-l-4 border-indigo-600 pl-1.5' 
              : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 pl-2'
          }`}
          style={{ paddingLeft: `${depth * 12 + (isSelected ? 6 : 8)}px` }}
          onClick={() => {
            setSelectedCategorySlug(isSelected ? '' : node.slug);
            if (onSelect) onSelect();
          }}
        >
          <span className="text-xs truncate flex-1 leading-none">{node.name}</span>
          <div className="flex items-center gap-1 shrink-0 ml-2">
            <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full font-medium">
              {node.totalCount}
            </span>
            {hasChildren && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCategoryExpand(node.slug);
                }}
                className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors"
              >
                {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </button>
            )}
          </div>
        </div>
        {hasChildren && isExpanded && (
          <div className="mt-0.5 space-y-0.5 ml-2 border-l border-gray-100 pl-1">
            {node.children.map(child => renderCategoryItem(child, depth + 1, onSelect))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Products</h1>
          <p className="text-sm text-gray-500 mt-0.5">Live from your WooCommerce store</p>
        </div>
        <div className="flex items-center gap-2">
          {fetched && products.length > 0 && (
            <button
              onClick={handleSync}
              disabled={syncing || loading}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-60 shadow-sm transition-colors cursor-pointer"
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing...' : 'Sync to Database'}
            </button>
          )}
          <button
            onClick={fetchProducts}
            disabled={loading || syncing}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-60 shadow-sm transition-colors cursor-pointer"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {fetched ? 'Refresh' : 'Load Products'}
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
            <p className="text-sm font-semibold text-rose-700">Connection Error</p>
            <p className="text-xs text-rose-600 mt-0.5">{error}</p>
            <p className="text-xs text-rose-500 mt-1">Please configure your WooCommerce settings in the <strong>Settings</strong> page first.</p>
          </div>
        </div>
      )}

      {!fetched && !loading && !error && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-10 text-center max-w-xl mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-4">
            <Package size={28} className="text-indigo-400" />
          </div>
          <h3 className="text-base font-semibold text-gray-700 mb-1">Load WooCommerce Products</h3>
          <p className="text-sm text-gray-400 max-w-sm mx-auto mb-4 leading-relaxed">
            Click "Load Products" to fetch your live inventory directly from WooCommerce.
            Make sure you've added your store URL and API keys in Settings.
          </p>
          <button
            onClick={fetchProducts}
            className="px-5 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 shadow-sm transition-colors cursor-pointer"
          >
            Load Products
          </button>
        </div>
      )}

      {loading && <Loader text="Fetching WooCommerce products..." />}

      {fetched && !loading && (
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
              {selectedCategorySlug && (
                <button 
                  onClick={() => setSelectedCategorySlug('')}
                  className="text-[10px] font-semibold text-indigo-600 hover:text-indigo-800 transition-colors cursor-pointer"
                >
                  Clear filter
                </button>
              )}
            </div>
            <div className="space-y-1">
              <div 
                className={`flex items-center gap-2 py-1.5 px-2 rounded-xl cursor-pointer transition-colors ${
                  !selectedCategorySlug 
                    ? 'bg-indigo-50 text-indigo-700 font-semibold' 
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
                onClick={() => setSelectedCategorySlug('')}
              >
                <Grid size={12} className={!selectedCategorySlug ? 'text-indigo-600' : 'text-gray-400'} />
                <span className="text-xs">All Products</span>
                <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full ml-auto font-medium">
                  {products.length}
                </span>
              </div>
              {categoryTree.map(node => renderCategoryItem(node, 0))}
            </div>
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
              <Filter size={14} className={selectedCategorySlug ? 'text-indigo-600' : 'text-gray-400'} />
              <span>Filter</span>
              {selectedCategorySlug && (
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
                <div className="space-y-1">
                  <div 
                    className={`flex items-center gap-2 py-2 px-2 rounded-xl cursor-pointer transition-colors ${
                      !selectedCategorySlug 
                        ? 'bg-indigo-50 text-indigo-700 font-semibold' 
                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                    }`}
                    onClick={() => {
                      setSelectedCategorySlug('');
                      setIsFilterDrawerOpen(false);
                    }}
                  >
                    <Grid size={12} className={!selectedCategorySlug ? 'text-indigo-600' : 'text-gray-400'} />
                    <span className="text-xs">All Products</span>
                    <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full ml-auto font-medium">
                      {products.length}
                    </span>
                  </div>
                  {categoryTree.map(node => renderCategoryItem(node, 0, () => setIsFilterDrawerOpen(false)))}
                </div>
                {selectedCategorySlug && (
                  <div className="mt-auto pt-4 border-t border-gray-100">
                    <button
                      onClick={() => {
                        setSelectedCategorySlug('');
                        setIsFilterDrawerOpen(false);
                      }}
                      className="w-full py-2.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold rounded-xl transition-colors cursor-pointer"
                    >
                      Clear Category Filter
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex-1 w-full">
            {(selectedCategorySlug || searchQuery) && (
              <div className="flex flex-wrap items-center gap-2 mb-4 bg-white border border-gray-100 rounded-2xl p-3 shadow-sm">
                <span className="text-xs font-bold text-gray-400 uppercase tracking-wider ml-1">Filters:</span>
                {selectedCategorySlug && (
                  <span className="flex items-center gap-1.5 bg-indigo-50 text-indigo-700 text-xs px-3 py-1 rounded-full font-medium shadow-sm">
                    Category: {getCategoryNameBySlug(selectedCategorySlug)}
                    <button 
                      onClick={() => setSelectedCategorySlug('')}
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
                    setSelectedCategorySlug('');
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
              <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredProducts.map(product => {
                  const image = product.images?.[0]?.src;
                  const inStock = product.stock_status === 'instock';
                  return (
                    <div key={product.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden hover:shadow-md transition-shadow group flex flex-col justify-between">
                      <div>
                        <div className="aspect-square bg-gray-50 overflow-hidden relative">
                          {image ? (
                            <img
                              src={image}
                              alt={product.name}
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
                          {product.categories?.length > 0 && (
                            <p className="text-[10px] text-gray-400 mt-2 truncate font-medium">
                              {product.categories.map(c => c.name).join(', ')}
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
            )}
          </div>
        </div>
      )}
    </div>
  );
}
