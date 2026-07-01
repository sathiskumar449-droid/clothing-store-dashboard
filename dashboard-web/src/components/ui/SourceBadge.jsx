import { getSourceBadge } from '../../utils/orderSource';

export default function SourceBadge({ order }) {
  const { label, className } = getSourceBadge(order);
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${className}`}>
      {label}
    </span>
  );
}
