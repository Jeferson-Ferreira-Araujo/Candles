export function OperationsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Operações</h1>
        <p className="text-slate-400 text-sm">Sinais confirmados e resultado de cada ordem enviada.</p>
      </div>
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
        Ainda não há um serviço de ordens implementado (SafetyGate + OrderService — próxima etapa). Por enquanto,
        sinais confirmados aparecem em <span className="text-slate-200">Logs</span> como eventos{' '}
        <code className="text-emerald-400">PATTERN_CONFIRMED</code>, mas nenhuma ordem é enviada à corretora ainda.
      </div>
    </div>
  );
}
