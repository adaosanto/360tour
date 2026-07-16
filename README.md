# Marzipano Clone

Aplicacao simples em FastAPI para transformar panoramas 360 equiretangulares em tours virtuais exportaveis.

## Recursos

- Upload por selecao ou drag-and-drop de uma ou varias imagens JPEG, PNG ou TIFF.
- Validacao de panoramas 2:1.
- Conversao equiretangular para cubemap com `py360convert`.
- Geracao de piramide multirresolucao de tiles JPEG com Pillow.
- Preview e editor usando a biblioteca Marzipano.
- Extracao de coordenadas GPS e altitude a partir do EXIF da foto.
- Cenas renomeaveis, reordenaveis e removiveis.
- Vista inicial por yaw, pitch e fov atuais do visualizador.
- Hotspots de informacao e link, com posicionamento e reposicionamento direto no panorama.
- Configuracoes de autorrotacao, controles, tela cheia, lista de panoramas e navegacao Drag/QTVR.
- Exportacao ZIP com app estatica completa.
- Mapa no tour exportado com tiles satelite e marcadores das fotos com coordenadas EXIF.
- Projetos temporarios por UUID com limpeza automatica por idade.

## Instalar

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

O arquivo `app/static/marzipano.js` ja deve existir. Se precisar recriar a partir do pacote npm:

```bash
npm install marzipano
cp node_modules/marzipano/dist/marzipano.js app/static/marzipano.js
```

## Executar

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Acesse `http://localhost:8000`.

## Endpoints

- `POST /api/projects` envia panoramas e cria um projeto temporario.
- `POST /api/projects/{project_id}/panoramas` adiciona panoramas ao projeto.
- `GET /api/projects/{project_id}/progress` consulta progresso.
- `GET /projects/{project_id}` abre o editor do projeto.
- `GET /api/projects/{project_id}/export` exporta o ZIP.
- `DELETE /api/projects/{project_id}` exclui o projeto temporario.

## Limpeza temporaria

Configure a idade maxima em horas com:

```bash
export TEMP_PROJECT_TTL_HOURS=24
```
