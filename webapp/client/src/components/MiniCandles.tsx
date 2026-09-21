import type { CandleColor } from '@polarium12c/shared';

interface Props {
  /** Cores ja fechadas e casadas com o padrao, da mais antiga para a mais nova (0..total). */
  received: CandleColor[];
  total: number; // total de slots a desenhar (tamanho do prefixo do padrao ativo)
}

const SLOT_WIDTH = 17;
const SLOT_GAP = 4;
const HEIGHT = 60;

/** Corpo/pavio de candle "sintetico": nao e o candle real do mercado, so a cor casada
 * pela regra (G/R) — serve para visualizar a formacao do padrao, nao para leitura de preco. */
function CandleGlyph({ color, x, closed }: { color: CandleColor | 'EMPTY'; x: number; closed: boolean }) {
  const bodyHeight = color === 'EMPTY' ? 0 : 22;
  const wickHeight = color === 'EMPTY' ? 0 : 34;
  const midY = HEIGHT / 2;
  const fill = color === 'G' ? '#16a34a' : color === 'R' ? '#dc2626' : 'transparent';

  if (color === 'EMPTY') {
    return (
      <g>
        <rect
          x={x}
          y={midY - 11}
          width={SLOT_WIDTH}
          height={22}
          rx={2}
          fill="none"
          stroke="#334155"
          strokeDasharray="3 3"
        />
      </g>
    );
  }

  return (
    <g opacity={closed ? 1 : 0.55}>
      <line x1={x + SLOT_WIDTH / 2} y1={midY - wickHeight / 2} x2={x + SLOT_WIDTH / 2} y2={midY + wickHeight / 2} stroke={fill} strokeWidth={2} />
      <rect x={x} y={midY - bodyHeight / 2} width={SLOT_WIDTH} height={bodyHeight} rx={2} fill={fill} />
      {!closed && <rect x={x} y={midY - bodyHeight / 2} width={SLOT_WIDTH} height={bodyHeight} rx={2} fill="url(#formingHatch)" />}
    </g>
  );
}

export function MiniCandles({ received, total }: Props) {
  const width = total * SLOT_WIDTH + (total - 1) * SLOT_GAP;

  return (
    <div className="overflow-x-auto">
      <svg width={width} height={HEIGHT}>
        <defs>
          <pattern id="formingHatch" width="4" height="4" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="4" stroke="#0f172a" strokeWidth="2" />
          </pattern>
        </defs>
        {Array.from({ length: total }).map((_, i) => {
          const x = i * (SLOT_WIDTH + SLOT_GAP);
          const color = received[i];
          return <CandleGlyph key={i} x={x} color={color ?? 'EMPTY'} closed />;
        })}
      </svg>
      <div className="flex text-[10px] text-slate-500 mt-1" style={{ width }}>
        {Array.from({ length: total }).map((_, i) => (
          <span key={i} style={{ width: SLOT_WIDTH + SLOT_GAP }} className="text-center">
            {i + 1}
          </span>
        ))}
      </div>
    </div>
  );
}
