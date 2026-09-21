import type { PatternDisplayState } from './types.js';

/**
 * Regra final, aplicada a QUALQUER padrao definido pelo usuario (independente da sequencia
 * criada): a vela de SINAL (a ultima do prefixo de confirmacao, a que fecha o padrao) precisa
 * ter um pavio inferior de pelo menos este percentual do seu range (high - low). Isso indica
 * uma rejeicao forte contra a direcao oposta a vela — sem isso, a ocorrencia NAO conta: nao
 * confirma ao vivo (nenhum sinal/ordem e gerado) e nao entra na lista de analise/backtest.
 */
export const SIGNAL_WICK_MIN_LOWER_PERCENTAGE = 0.25;

/**
 * Estado de exibicao do card de monitor, relativo ao TAMANHO DO PADRAO ATIVO (patternLength) —
 * nao a um numero fixo — para continuar correto conforme o usuario troca de padrao customizado
 * na tela de edicao de padrao.
 */
export function patternDisplayState(matchedLength: number, patternLength: number): PatternDisplayState {
  if (matchedLength >= patternLength) return 'CONFIRMADO';
  if (matchedLength === patternLength - 1) return 'ACOMPANHANDO';
  return 'MONITORANDO';
}
