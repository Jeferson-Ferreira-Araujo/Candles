import { useMemo, useState } from 'react';
import type { AssetInfo } from '@polarium12c/shared';

interface Props {
  assets: AssetInfo[];
  value: number[];
  onChange: (ids: number[]) => void;
}

/**
 * Selecao de ativos por badges clicaveis (nao um dropdown de busca) — pensada para escolher
 * rapidamente alguns poucos ativos entre varias dezenas, sem precisar digitar nada.
 */
export function AssetBadgePicker({ assets, value, onChange }: Props) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((a) => a.name.toLowerCase().includes(q));
  }, [assets, query]);

  function toggle(id: number) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrar por nome..."
          className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-1.5 text-xs flex-1 min-w-[160px]"
        />
        {value.length > 0 && (
          <button type="button" onClick={() => onChange([])} className="text-xs text-slate-400 hover:text-slate-200 underline">
            Limpar seleção ({value.length})
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 max-h-56 overflow-y-auto">
        {assets.length === 0 && <div className="text-xs text-slate-500">Carregando ativos...</div>}
        {filtered.map((a) => {
          const selected = value.includes(a.id);
          return (
            <button
              type="button"
              key={a.id}
              onClick={() => toggle(a.id)}
              className={`text-xs px-2 py-1 rounded-full border transition-colors ${
                selected ? 'bg-sky-700 border-sky-500 text-white' : 'bg-slate-950 border-slate-700 text-slate-300 hover:border-slate-500'
              }`}
            >
              {a.name}
            </button>
          );
        })}
        {assets.length > 0 && filtered.length === 0 && <div className="text-xs text-slate-500">Nenhum ativo encontrado.</div>}
      </div>
    </div>
  );
}
