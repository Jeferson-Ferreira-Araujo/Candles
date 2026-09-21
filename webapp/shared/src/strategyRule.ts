import type { PatternDisplayState } from './types.js';

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
