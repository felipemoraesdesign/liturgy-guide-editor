#!/bin/bash
# Inicia o Liturgy Guide Editor e abre no navegador.
# Duplo-clique pra rodar.

cd "$(dirname "$0")"
PORT=8765
URL="http://localhost:${PORT}/editor.html"

# Se já tem servidor rodando nessa porta, só abre o browser
if lsof -i ":${PORT}" >/dev/null 2>&1; then
  echo "Servidor já está rodando em ${URL}"
  open "${URL}"
  exit 0
fi

# Inicia o servidor em background
python3 server.py "${PORT}" &
SERVER_PID=$!

# Espera um instante e abre o navegador
sleep 1
open "${URL}"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Liturgy Guide Editor aberto em ${URL}"
echo "  Para parar: feche esta janela ou pressione Ctrl+C"
echo "═══════════════════════════════════════════════════════"
echo ""

# Mantém o terminal vivo até o servidor encerrar
wait $SERVER_PID
