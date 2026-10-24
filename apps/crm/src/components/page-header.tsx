export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-4 px-6 py-5">
      <div>
        <h1 className="text-lg font-semibold text-fg">{title}</h1>
        {subtitle && <p className="text-sm text-fg-subtle">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
