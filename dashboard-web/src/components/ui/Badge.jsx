const variants = {
  pending:   'bg-amber-100 text-amber-700 border border-amber-200',
  confirmed: 'bg-blue-100 text-blue-700 border border-blue-200',
  delivered: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
  cancelled: 'bg-rose-100 text-rose-700 border border-rose-200',
  active:    'bg-green-100 text-green-700 border border-green-200',
  paused:    'bg-gray-100 text-gray-600 border border-gray-200',
  default:   'bg-gray-100 text-gray-600 border border-gray-200',
};

export default function Badge({ label, status }) {
  const cls = variants[status?.toLowerCase()] || variants.default;
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {label || status}
    </span>
  );
}
