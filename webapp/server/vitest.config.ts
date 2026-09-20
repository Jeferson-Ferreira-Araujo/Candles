import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // Os testes compartilham um unico banco Postgres real (sem ":memory:" para Postgres) —
    // rodar arquivos em paralelo faria dois arquivos truncarem as mesmas tabelas ao mesmo
    // tempo. Isolamento por teste vem de resetDb() em beforeEach (ver test/helpers/testDb.ts).
    fileParallelism: false,
    // Testes fazem I/O real contra o Postgres (Supabase) pela rede — o timeout padrao de
    // 5s do Vitest e curto demais para os que envolvem polling (OrderService).
    testTimeout: 15000,
  },
});
