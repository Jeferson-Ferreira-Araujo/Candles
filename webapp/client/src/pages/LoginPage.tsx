import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

type Mode = 'credentials' | 'ssid';

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<Mode>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [ssid, setSsid] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  function friendlyError(err: unknown): string {
    // TypeError "Failed to fetch" e falha de rede (ex.: servidor Render ainda acordando de
    // hibernacao) — nao um erro de credencial. Login nunca e reenviado automaticamente
    // (ver reqNoRetry em api.ts), entao aqui so orientamos o usuario a tentar de novo.
    if (err instanceof TypeError) {
      return 'Não foi possível conectar ao servidor. Se ele estava inativo, aguarde ~30s e tente novamente.';
    }
    return err instanceof Error ? err.message : String(err);
  }

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.loginWithCredentials(email.trim(), password);
      setPassword('');
      onLoggedIn();
      navigate('/');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  async function submitSsid(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.login(ssid.trim());
      setSsid('');
      onLoggedIn();
      navigate('/');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="text-2xl font-bold">12 Candles</div>
          <div className="text-sm text-slate-500">Acesso restrito — apenas você.</div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 space-y-4">
          <div className="flex rounded-lg border border-slate-700 overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => switchMode('credentials')}
              className={`flex-1 py-2 font-medium transition-colors ${
                mode === 'credentials' ? 'bg-emerald-700 text-white' : 'bg-slate-950 text-slate-400 hover:text-slate-200'
              }`}
            >
              Email e senha
            </button>
            <button
              type="button"
              onClick={() => switchMode('ssid')}
              className={`flex-1 py-2 font-medium transition-colors ${
                mode === 'ssid' ? 'bg-emerald-700 text-white' : 'bg-slate-950 text-slate-400 hover:text-slate-200'
              }`}
            >
              SSID manual
            </button>
          </div>

          {mode === 'credentials' ? (
            <form onSubmit={submitCredentials} className="space-y-4">
              <div>
                <label className="block text-sm text-slate-300 mb-1">Email da Polarium</label>
                <input
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="seu@email.com"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                  required
                />
              </div>
              <div>
                <label className="block text-sm text-slate-300 mb-1">Senha da Polarium</label>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="sua senha"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
                  required
                />
              </div>

              {error && <div className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">{error}</div>}

              <button
                type="submit"
                disabled={loading || email.trim().length === 0 || password.length === 0}
                className="w-full rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-4 py-2 font-semibold text-sm"
              >
                {loading ? 'Entrando...' : 'Entrar'}
              </button>

              {loading && (
                <p className="text-xs text-slate-500 text-center">
                  O servidor está logando na Polarium por você (pode levar até 15s — mais, se ele estava hibernado).
                </p>
              )}

              <p className="text-xs text-slate-500">
                O servidor abre uma sessão de navegador temporária, loga na própria tela oficial da Polarium e extrai sua
                sessão automaticamente. Sua senha nunca é salva em disco nem em log — só existe na memória pelo tempo do
                login.
              </p>
            </form>
          ) : (
            <form onSubmit={submitSsid} className="space-y-4">
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

              {loading && (
                <p className="text-xs text-slate-500 text-center">
                  Se o servidor estiver hibernado por inatividade, isso pode levar até 1 minuto na primeira tentativa.
                </p>
              )}

              <p className="text-xs text-slate-500">
                Use isso só se o login por email/senha não funcionar. O SSID é a sua sessão já autenticada na Polarium
                (não a sua senha); fica salvo apenas na memória deste servidor, nunca em disco ou em log.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
