import { useState, useEffect } from "react";
import { createClient } from "@supabase/supabase-js";
import { Tag, Truck, Save, CheckCircle } from "lucide-react";

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

function Toggle({ checked, onChange }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${
        checked ? "bg-indigo-600" : "bg-gray-300"
      }`}
    >
      <div
        className={`w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200 mx-0.5 ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

const inputCls = "w-full px-3.5 py-2.5 min-h-11 text-sm rounded-xl border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition font-mono";

export default function CouponSettings() {
  const [couponCode, setCouponCode] = useState("");
  const [couponEnabled, setCouponEnabled] = useState(false);
  const [freeShipping, setFreeShipping] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    const { data, error: fetchError } = await supabase
      .from("store_settings")
      .select("coupon_code, coupon_enabled, free_shipping_with_coupon")
      .eq("id", 1)
      .single();
    if (fetchError) {
      setError("Couldn't load coupon settings. " + fetchError.message);
    } else if (data) {
      setCouponCode(data.coupon_code || "");
      setCouponEnabled(data.coupon_enabled || false);
      setFreeShipping(data.free_shipping_with_coupon ?? true);
    }
    setLoading(false);
  }

  async function saveSettings() {
    setSaving(true);
    setError("");
    const { error: saveError } = await supabase
      .from("store_settings")
      .update({
        coupon_code: couponCode.trim().toUpperCase(),
        coupon_enabled: couponEnabled,
        free_shipping_with_coupon: freeShipping,
      })
      .eq("id", 1);
    setSaving(false);
    if (saveError) {
      setError("Failed to save. " + saveError.message);
    } else {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 md:p-6">
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
        <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
          <Tag size={16} className="text-indigo-600" />
        </div>
        <h2 className="text-sm font-bold text-gray-800">Coupon Settings</h2>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
            <div>
              <p className="text-sm font-semibold text-gray-700">Coupon Active</p>
              <p className="text-xs text-gray-500 mt-0.5">Bot shares this code with customers</p>
            </div>
            <Toggle checked={couponEnabled} onChange={() => setCouponEnabled(v => !v)} />
          </div>

          <div>
            <label htmlFor="coupon-code" className="block text-xs font-semibold text-gray-500 mb-1.5">
              Coupon Code
            </label>
            <input
              id="coupon-code"
              type="text"
              value={couponCode}
              onChange={e => setCouponCode(e.target.value.toUpperCase())}
              placeholder="e.g. SUPER10"
              className={inputCls}
            />
          </div>

          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
            <div className="flex items-center gap-2">
              <Truck size={14} className="text-gray-400 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-gray-700">Free Shipping with Coupon</p>
                <p className="text-xs text-gray-500 mt-0.5">Bot mentions free shipping when sharing the code</p>
              </div>
            </div>
            <Toggle checked={freeShipping} onChange={() => setFreeShipping(v => !v)} />
          </div>

          {error && <p className="text-xs text-rose-600">{error}</p>}

          <button
            onClick={saveSettings}
            disabled={saving}
            className={`flex items-center gap-2 px-4 py-2.5 min-h-11 rounded-xl text-sm font-semibold transition-all duration-300 ease-in-out active:scale-95 ${
              saved
                ? "bg-emerald-600 text-white"
                : saving
                ? "bg-gray-300 text-gray-500"
                : "bg-indigo-600 text-white hover:bg-indigo-700"
            }`}
          >
            {saved ? <CheckCircle size={15} /> : <Save size={15} />}
            {saved ? "Saved!" : saving ? "Saving..." : "Save Coupon Settings"}
          </button>
        </div>
      )}
    </div>
  );
}
