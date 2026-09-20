# Coletor de Candles Históricos — Polarium Broker

Ferramenta simples para baixar candles históricos (M1 por padrão, e opcionalmente 5s/1s)
da Polarium Broker, usando o SDK oficial da Quadcode (`@quadcode-tech/client-sdk-js`), e
gerar CSVs para uso posterior em backtests/análise estatística.

**Este projeto NÃO abre operações, NÃO envia ordens, NÃO possui interface gráfica e NÃO
usa banco de dados.** A única função é coletar candles históricos e salvar em CSV.

## Requisitos

- Node.js 20 ou superior (recomendado)

## Instalação

```bash
npm install
```

## Configurar o SSID (Windows PowerShell)

O SSID é a sua sessão autenticada na Polarium. Ele **nunca** deve ser digitado no código
nem salvo em arquivo — configure-o apenas como variável de ambiente na sessão atual do
PowerShell:

```powershell
$env:POLARIUM_SSID = "cole_aqui_seu_ssid"
```

Essa variável vale apenas para a janela do PowerShell atual. Feche o terminal e ela some —
é o comportamento esperado, para não deixar a credencial persistida em disco.

Opcionalmente, também é possível ajustar (sem editar o código):

```powershell
$env:POLARIUM_ACTIVE_ID = "2298"     # ID do ativo (confirme o valor correto)
$env:POLARIUM_PLATFORM_ID = "82"     # platformId exigido pelo SDK (confirme com a Polarium)
```

## Descobrir o ACTIVE_ID de outros pares (inclusive OTC e digital)

Antes de coletar um ativo diferente, use o script auxiliar (também somente leitura, sem
abrir ordens) para listar os IDs disponíveis:

```powershell
npm run list-actives
```

Para filtrar por nome (ex.: só pares com "EUR"):

```powershell
npm run list-actives -- --filter eur
```

Ele lista separadamente os ativos de **binary options** e os **underlyings de digital
options** (que incluem os pares OTC), cada um com seu `ID` e `ticker/nome`.

## Executar a coleta

```powershell
npm run collect
```

### Parametrizar sem editar o código

Todos os parâmetros da coleta aceitam flag de linha de comando (tem prioridade) ou
variável de ambiente, então o mesmo `collect.js` serve para qualquer ativo e período:

```powershell
npm run collect -- --active 76 --days 5 --size 60 --out eurusd_otc.csv
```

| Parâmetro         | Flag       | Variável de ambiente      | Padrão         |
|-------------------|------------|----------------------------|----------------|
| Ativo(s) — um ou vários, separados por vírgula | `--active` | `POLARIUM_ACTIVE_ID` | `2298` |
| Dias de histórico  | `--days`   | `POLARIUM_DAYS`            | `3`            |
| Horas de histórico (alternativa a `--days`, para testes curtos) | `--hours` | `POLARIUM_HOURS` | — |
| Tamanho do candle (s) | `--size` | `POLARIUM_CANDLE_SIZE`   | `60` (M1)      |
| Arquivo de saída   | `--out`    | `POLARIUM_OUTPUT_FILE`     | `candles.csv` (ou `candles_5s.csv`/`candles_1s.csv` conforme `--size`) |
| Arquivo de gaps    | `--gapsOut`| `POLARIUM_GAPS_FILE`       | `gaps.csv` (ou `gaps_5s.csv`/`gaps_1s.csv`) |
| Platform ID        | —          | `POLARIUM_PLATFORM_ID`     | `82`           |

`--flag valor` e `--flag=valor` funcionam. **Atenção (ver aviso acima):** em alguns
terminais PowerShell, `npm run collect -- --flag valor` não repassa as flags — se isso
acontecer, use as variáveis de ambiente equivalentes.

Exemplo rodando para outro par direto por variável de ambiente:

```powershell
$env:POLARIUM_ACTIVE_ID = "76"
$env:POLARIUM_OUTPUT_FILE = "eurusd_otc.csv"
npm run collect
```

## Vários ativos em um único CSV

Para analisar 3 ativos ao mesmo tempo durante 30 dias, passe os IDs separados por vírgula
(descubra cada um com `npm run list-actives`):

```powershell
$env:POLARIUM_SSID = "seu_ssid_atual"
$env:POLARIUM_ACTIVE_ID = "81,76,2298"
$env:POLARIUM_DAYS = "30"
npm run collect
```

ou por flag (se funcionar no seu terminal — ver aviso sobre PowerShell):

```powershell
npm run collect -- --active=81,76,2298 --days=30
```

Isso conecta e autentica **uma única vez**, e coleta os três ativos em sequência, todos
no mesmo `candles.csv` (ou `candles_5s.csv`, etc.), com uma coluna **`active_id`** a mais
no início de cada linha para você filtrar/agrupar por ativo depois (ex.: `df.groupby
('active_id')` no pandas). O resumo final no terminal mostra as estatísticas
(recebidos/esperados/gaps) separadamente para cada ativo, além do total geral. O arquivo
de gaps (`gaps.csv`) também ganha a coluna `active_id`.

O script irá:

1. Conectar e autenticar no WebSocket da Polarium via SDK oficial (inalterado).
2. Buscar candles no `CANDLE_SIZE` pedido, em blocos de até 24h (paginando para trás
   dentro de cada bloco, até 1000 candles por requisição), mostrando progresso bloco a
   bloco no terminal.
3. Gravar cada bloco no CSV incrementalmente (sem acumular tudo em memória de uma vez —
   importante para coletas grandes, como 30 dias de candles de 5 segundos).
4. Descartar (e contar) qualquer candle com `open`/`high`/`low`/`close` ausente/inválido.
5. Detectar lacunas (gaps) maiores que `CANDLE_SIZE` segundos entre candles consecutivos
   e gravá-las em um CSV separado (`gaps.csv`/`gaps_5s.csv`/etc.), sem preenchê-las
   artificialmente.
6. Exibir um resumo final no terminal com ativo, período, candles recebidos/esperados,
   gaps e status da disponibilidade de histórico de ticks (ver seção abaixo).

## Granularidades sub-minuto (5 segundos / 1 segundo)

O SDK **não valida `candleSize` no cliente** — ele repassa qualquer valor para o servidor
da Polarium. Isso significa que `5` e `1` segundos são tecnicamente tentados, mas só o
servidor pode confirmar se existe histórico nessa granularidade para o ativo pedido. Se
não houver dados, o script avisa claramente (nenhum dado é inventado):

```powershell
$env:POLARIUM_SSID = "seu_ssid_atual"
npm run collect -- --active 81 --size=5 --days=1 --out=candles_5s.csv
```

**Recomendação de teste progressivo (evite ir direto para 30 dias):**

1. `--size=5 --days=1` (~17.280 candles esperados) — valide que os dados fazem sentido.
2. Se funcionar, `--size=5 --days=30` (~518.400 candles, coletado em ~30 blocos diários).
3. Só depois teste `--size=1` (1 segundo), começando com `--hours=1` (~3.600 candles).
   **Não** rode `--size=1` com `--days=30` de cara — é um teste experimental separado.

## Dataset intravela M1 (a partir do CSV de 5 segundos)

Depois de gerar `candles_5s.csv`, rode (sem precisar de rede/SSID — processa o CSV local):

```powershell
npm run build-intracandle
```

ou apontando para outro arquivo:

```powershell
node build-intracandle.js --in=candles_5s.csv --out=m1_intracandle.csv
```

Isso gera `m1_intracandle.csv`, com **uma linha por minuto M1 por ativo**, contendo:

- `active_id` — para diferenciar os minutos de cada ativo quando `candles_5s.csv` tem
  mais de um.
- Os até 12 sub-candles de 5s daquele minuto (`s00_open..s55_close`); slots ausentes
  ficam em branco (nunca preenchidos artificialmente) e `subcandles_count` informa
  quantos dos 12 existem.
- Features intravela (retornos e ranges das janelas iniciais/finais, contagem de
  sub-candles verdes/vermelhos/doji, `close_position`, aceleração final, direções).
- `next_m1_open`, `next_m1_close`, `next_m1_direction` (`CALL`/`PUT`/`DOJI`) como
  **target** da M1 seguinte — nunca usado para calcular as features da própria M1 atual
  (sem data leakage). Fica vazio quando a M1 seguinte não é contígua **ou é de outro
  ativo** (o target nunca atravessa a fronteira entre ativos diferentes).

Este script não implementa estratégia, sinal de entrada nem indicador — só organiza o
dataset para análise estatística posterior.

## Onde encontrar o resultado

O arquivo `candles.csv` é criado na raiz do projeto, no formato (note a coluna
`active_id` no início — presente mesmo quando você coleta um único ativo):

```
active_id,timestamp,date,open,high,low,close
2298,1788895920,2026-09-08T12:52:00.000Z,4.854485,4.854485,4.848105,4.851955
```

## Configurações

Os valores padrão ficam no início de `collect.js`, mas podem ser sobrescritos por flag ou
variável de ambiente (ver tabela acima):

- `ACTIVE_ID` — ID do ativo na Quadcode/Polarium (padrão de exemplo: `2298`; **confirme**
  o ID correto do ativo que deseja coletar com `npm run list-actives`).
- `CANDLE_SIZE` — tamanho do candle em segundos (`60` = M1).
- `DAYS` — quantidade de dias de histórico a coletar (`3`).
- `PLATFORM_ID` — identificador de plataforma exigido pela assinatura oficial
  `ClientSdk.create(apiUrl, platformId, authMethod, options?)`. Os exemplos da
  documentação do SDK usam `82`, mas esse valor **não é documentado oficialmente para
  brokers white-label** como a Polarium — confirme com o suporte da Polarium/Quadcode se
  necessário.

## Ativos OTC e Digital Options

O CSV gerado contém apenas candles (preço), que são os mesmos independentemente de você
operar depois via binary ou digital options — a diferença entre esses modos está na forma
de contrato/expiração, não no histórico de preço. Para ativos **OTC**, use
`npm run list-actives` para achar o ID correto (o nome normalmente aparece com sufixo
"-OTC"); o restante do fluxo (`collect.js`) é idêntico.

## Histórico de ticks/quotes (bid/ask)

Investigado no código-fonte real do SDK instalado (`@quadcode-tech/client-sdk-js@1.3.26`):
a classe `Quotes` só expõe `getCurrentQuoteForActive()` (cotação **atual**, em tempo real);
não existe nenhum método de histórico de ticks, bid/ask, ou eventos como
`quote-generated` com paginação histórica em nenhum lugar do SDK. Conclusão:

**HISTÓRICO DE TICKS NÃO DISPONÍVEL PELO MÉTODO ENCONTRADO.**

O objeto `Candle` devolvido pelo histórico também não traz `bid`/`ask` — só
`open/high/low/close/volume`. Por isso os CSVs gerados não têm essas colunas: nada foi
estimado ou inventado.

## Aviso de segurança

- **Nunca compartilhe seu SSID, tokens ou cookies com terceiros.**
- O script não salva o SSID em nenhum arquivo, não grava cookies e não registra
  credenciais no console.
- O script não solicita senha em nenhum momento.
- Nenhuma funcionalidade de negociação (CALL, PUT, digital options etc.) é implementada
  ou chamada por este projeto.
