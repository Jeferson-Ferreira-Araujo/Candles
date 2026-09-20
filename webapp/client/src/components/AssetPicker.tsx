import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssetInfo, AssetKind } from '@polarium12c/shared';
import { api } from '../api.js';

const KIND_LABEL: Record<AssetKind, string> = {
  binary: 'Binary',
  turbo: 'Turbo',
  blitz: 'Blitz',
  digital: 'Digital',
};

const KIND_STYLE: Record<AssetKind, string> = {
  binary: 'bg-slate-700 text-slate-200',
  turbo: 'bg-indigo-800 text-indigo-100',
  blitz: 'bg-amber-800 text-amber-100',
  digital: 'bg-sky-800 text-sky-100',
};

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${className}`}>{children}</span>;
}

interface AssetPickerProps {
  value: number[];
  onChange: (ids: number[]) => void;
  placeholder?: string;
}

/**
 * Seletor de ativos com busca por nome (em vez de digitar IDs crus), mostrando se cada
 * ativo e OTC e em quais tipos de opcao ele aparece (Binary/Turbo/Blitz/Digital).
 * Ativos ja selecionados que a corretora nao devolveu mais (ou que ainda nao carregaram)
 * continuam aparecendo como chip "Ativo {id}" — nunca perde uma selecao silenciosamente.
 */
export function AssetPicker({ value, onChange, placeholder }: AssetPickerProps) {
  const [assets, setAssets] = useState<AssetInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .getAssets()
      .then(setAssets)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const filtered = useMemo(() => {
    if (!assets) return [];
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((a) => a.name.toLowerCase().includes(q) || String(a.id).includes(q));
  }, [assets, query]);

  function toggle(id: number) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  const selectedKnown = assets?.filter((a) => value.includes(a.id)) ?? [];
  const selectedUnknownIds = value.filter((id) => !assets?.some((a) => a.id === id));

  return (
    <div className="relative" ref={containerRef}>
      {(selectedKnown.length > 0 || selectedUnknownIds.length > 0) && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selectedKnown.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1.5 bg-slate-800 border border-slate-700 rounded-full pl-2.5 pr-1.5 py-1 text-xs">
              {a.name}
              {a.isOtc && <Badge className="bg-slate-700 text-slate-300">OTC</Badge>}
              <button type="button" onClick={() => toggle(a.id)} className="text-slate-500 hover:text-slate-200 leading-none px-0.5" aria-label={`Remover ${a.name}`}>
                ×
              </button>
            </span>
          ))}
          {selectedUnknownIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1.5 bg-slate-800 border border-slate-700 rounded-full pl-2.5 pr-1.5 py-1 text-xs text-slate-400">
              Ativo {id}
              <button type="button" onClick={() => toggle(id)} className="text-slate-500 hover:text-slate-200 leading-none px-0.5" aria-label={`Remover ativo ${id}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder ?? 'Buscar ativo por nome...'}
        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm"
      />

      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
          {error && <div className="p-3 text-xs text-rose-400">Falha ao carregar ativos: {error}</div>}
          {!assets && !error && <div className="p-3 text-xs text-slate-500">Carregando ativos...</div>}
          {assets && filtered.length === 0 && <div className="p-3 text-xs text-slate-500">Nenhum ativo encontrado.</div>}
          {filtered.map((a) => {
            const checked = value.includes(a.id);
            return (
              <button
                type="button"
                key={a.id}
                onClick={() => toggle(a.id)}
                className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-slate-800 ${checked ? 'bg-slate-800/70' : ''}`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <input type="checkbox" readOnly checked={checked} className="pointer-events-none shrink-0" />
                  <span className="truncate">{a.name}</span>
                  <span className="text-slate-600 text-xs shrink-0">#{a.id}</span>
                </span>
                <span className="flex gap-1 shrink-0">
                  {a.isOtc && <Badge className="bg-slate-700 text-slate-300">OTC</Badge>}
                  {a.kinds.map((k) => (
                    <Badge key={k} className={KIND_STYLE[k]}>
                      {KIND_LABEL[k]}
                    </Badge>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
