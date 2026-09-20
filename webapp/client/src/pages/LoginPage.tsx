import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [ssid, setSsid] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.login(ssid.trim());
      setSsid('');
      onLoggedIn();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="text-2xl font-bold">12 Candles</div>
          <div className="text-sm text-slate-500">Acesso restrito — apenas você.</div>
        </div>

        <form onSubmit={submit} className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4">
          <div>
            <label className="block text-sm text-slate-300 mb-1">SSID da Polarium</label>
            <input
              type="password"
              autoComplete="off"
              value={ssid}
              onChange={(e) => setSsid(e.target.value)}
              placeholder="cole aqui o SSID da sua sessão"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
              required
            />
          </div>

          {error && <div className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">{error}</div>}

          <button
            type="submit"
            disabled={loading || ssid.trim().length === 0}
            className="w-full rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-4 py-2 font-semibold text-sm"
          >
            {loading ? 'Entrando...' : 'Entrar'}
          </button>

          <p className="text-xs text-slate-500">
            O SSID é a sua sessão já autenticada na Polarium (não a sua senha). Nunca compartilhe esse valor — ele
            fica salvo apenas na memória deste servidor, nunca em disco ou em log.
          </p>
        </form>
      </div>
    </div>
  );
}
