# Marzipano Clone

Aplicacao simples em FastAPI para transformar panoramas 360 equiretangulares em tours virtuais exportaveis.

## Recursos

- Criacao de projeto por UUID com thumbnail opcional salva em disco.
- Upload de panoramas JPEG, PNG ou TIFF dentro do editor.
- Validacao de panoramas 2:1.
- Conversao equiretangular para cubemap com `py360convert`.
- Geracao de piramide multirresolucao de tiles JPEG com Pillow.
- Preview e editor usando a biblioteca Marzipano.
- Visualizacao publica em `/view/{project_id}` com layout semelhante ao Marzipano Tool.
- Extracao de coordenadas GPS, data, altura relativa e altitude a partir do EXIF/XMP da foto quando disponiveis.
- Cenas renomeaveis, reordenaveis e removiveis.
- Vista inicial por yaw, pitch e fov atuais do visualizador.
- Hotspots de informacao e link, com posicionamento e reposicionamento direto no panorama.
- Configuracoes de autorrotacao, controles, tela cheia, lista de panoramas e navegacao Drag/QTVR.
- Exportacao ZIP com app estatica completa.
- Mapa no visualizador e no tour exportado com tiles satelite e marcadores das fotos com coordenadas EXIF.
- Data da foto a partir do EXIF, mapa navegavel por drag/wheel e opcao para exibir o campo Foto nos metadados.
- Projetos por UUID indexados em SQLite com SQLAlchemy.
- Storage fisico configuravel para uploads, tiles, assets, exports e `project.json`.

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

- `POST /api/projects` cria um projeto temporario; aceita `project_name`, `thumbnail`, `tile_size` e `jpeg_quality`.
- `GET /api/projects` lista os projetos registrados.
- `POST /api/projects/{project_id}/panoramas` adiciona panoramas ao projeto.
- `GET /api/projects/{project_id}/progress` consulta progresso.
- `GET /projects/{project_id}` abre o editor do projeto.
- `GET /view/{project_id}` abre o visualizador publico do projeto.
- `GET /api/projects/{project_id}/export` exporta o ZIP.
- `DELETE /api/projects/{project_id}` exclui o projeto temporario.

## Storage e banco

Por padrao, arquivos e banco ficam em `app/temp`:

```text
app/temp/
├── projects.sqlite3
└── {project_id}/
    ├── project.json
    ├── assets/
    ├── uploads/
    └── tiles/
```

Configure outro local para storage fisico com:

```bash
export STORAGE_DIR=/caminho/para/storage
```

Tambem e possivel criar um arquivo `.env` na raiz do projeto usando `.env.example` como base.

Por padrao o SQLite fica em `${STORAGE_DIR}/projects.sqlite3`. Para apontar outro banco SQLAlchemy:

```bash
export DATABASE_URL=sqlite:////caminho/para/projects.sqlite3
```

## Limpeza temporaria

Configure a idade maxima em horas com:

```bash
export TEMP_PROJECT_TTL_HOURS=24
```
