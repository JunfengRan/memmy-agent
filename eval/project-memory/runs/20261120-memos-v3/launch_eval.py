import os
import sys

from pathlib import Path

from dotenv import dotenv_values

repo = Path(os.getenv("MEMOS_V3_REPO", "/Users/junfengran/repos/MemOS-add"))
# replay_app.py (the evaluation clock) sits next to this launcher.
here = Path(__file__).resolve().parent
root = Path("/tmp/memos-add-verify-run")
port = int(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "serve"
base = root / str(port)
(base / "download").mkdir(parents=True, exist_ok=True)
source = dotenv_values("/Users/junfengran/repos/MemOS/.env")
prefixes = ("OPENAI_", "MOS_CHAT_", "MOS_EMBEDDER_", "MEMRADER_", "MEMREADER_")
settings = {name: value for name, value in source.items() if name.startswith(prefixes) and value}
settings.update({
    "EMBEDDING_DIMENSION": source.get("EMBEDDING_DIMENSION") or "1024",
    "MEMOS_BASE_PATH": str(base),
    "FILE_LOCAL_PATH": str(base / "download"),
    "MEMOS_ENABLED_PLUGINS": "project_memory",
    "MEMOS_DISABLED_PLUGINS": "dream",
    "PROJECT_MEMORY_GRAPH_DB": "postgres",
    "PROJECT_MEMORY_PROJECT_ID": "add-verify",
    "PROJECT_MEMORY_POSTGRES_DSN": "postgresql://add_verify@127.0.0.1:55439/add_verify",
    "PROJECT_MEMORY_POSTGRES_SCHEMA": "add_runtime_verify",
    "PROJECT_MEMORY_EPISODE_MAX_TURNS": "2",
    "PROJECT_MEMORY_EPISODE_IDLE_SECONDS": "15",
    "PROJECT_MEMORY_SCAN_SECONDS": "1",
    "PROJECT_MEMORY_FORMATION_COUNT": "1",
    "PROJECT_MEMORY_PUBLISH_STALE_SECONDS": "3",
    "PROJECT_MEMORY_STAGE_LEASE_SECONDS": "30",
    # The v3 replay flushes a Space before each question and before the final read.
    "PROJECT_MEMORY_ENABLE_FLUSH": "true",
    "MEMSCHEDULER_USE_REDIS_QUEUE": "true",
    "MEMSCHEDULER_REDIS_STREAM_KEY_PREFIX": "addverify:run",
    "MEMSCHEDULER_STREAM_KEY_PREFIX": "addverify:run",
    "ENABLE_CHAT_API": "false",
    "REDIS_HOST": "127.0.0.1",
    "REDIS_PORT": "56389",
    "MEMSCHEDULER_REDIS_HOST": "127.0.0.1",
    "MEMSCHEDULER_REDIS_PORT": "56389",
    "MEMSCHEDULER_REDIS_DB": "0",
    "REDIS_DB": "0",
    "GRAPH_DB_BACKEND": "neo4j-community",
    "NEO4J_URI": "bolt://127.0.0.1:57687",
    "NEO4J_USER": "neo4j",
    "NEO4J_PASSWORD": "local-add-verify",
    "NEO4J_DB_NAME": "neo4j",
    "MOS_NEO4J_SHARED_DB": "false",
    "NEO4J_AUTO_CREATE": "true",
    "QDRANT_HOST": "127.0.0.1",
    "QDRANT_PORT": "56333",
    "MOS_RERANKER_BACKEND": "cosine_local",
    "MOS_FEEDBACK_RERANKER_BACKEND": "cosine_local",
    "PYTHONPATH": f"{repo}/src:/tmp/memos-add-verify-python",
})
if real_model := os.getenv("ADD_VERIFY_MODEL"):
    settings.update({
        "MOS_CHAT_MODEL": real_model,
        "PROJECT_MEMORY_POSTGRES_SCHEMA": "add_runtime_real_alt",
        "MEMSCHEDULER_REDIS_STREAM_KEY_PREFIX": "addverify:real-alt",
        "MEMSCHEDULER_STREAM_KEY_PREFIX": "addverify:real-alt",
        "PROJECT_MEMORY_STAGE_LEASE_SECONDS": "120",
    })
if profile := os.getenv("MEMOS_LOCAL_MODEL_PROFILE"):
    if profile not in ("deepseek", "openai", "claude"):
        raise ValueError("Use deepseek, openai or claude")
    config = dotenv_values(Path.home() / f".{profile}.env")
    model, api_base, api_key = (config.get(key) for key in ("MODEL", "OPENAI_API_BASE", "OPENAI_API_KEY"))
    if not all((model, api_base, api_key)):
        raise ValueError(f"Incomplete model environment for {profile}")
    settings.update({
        "MOS_CHAT_MODEL": model,
        "OPENAI_API_BASE": api_base,
        "OPENAI_API_KEY": api_key,
        "PROJECT_MEMORY_LLM_BACKEND": "openai",
        "PROJECT_MEMORY_LLM_MODEL": model,
        "PROJECT_MEMORY_LLM_API_BASE": api_base,
        "PROJECT_MEMORY_LLM_API_KEY": api_key,
        "MOS_EMBEDDER_BACKEND": "universal_api",
        "MOS_EMBEDDER_PROVIDER": "openai",
        "MOS_EMBEDDER_API_BASE": "http://127.0.0.1:58112/v1",
        "MOS_EMBEDDER_API_KEY": "local-model",
        "MOS_EMBEDDER_MODEL": "all-MiniLM-L6-v2",
        "EMBEDDING_DIMENSION": "384",
        "NO_PROXY": "127.0.0.1,localhost",
    })
    namespace = f"memos_v3_{port}"
    settings.update({
        "PROJECT_MEMORY_PROJECT_ID": namespace,
        "PROJECT_MEMORY_POSTGRES_SCHEMA": namespace,
        "MEMSCHEDULER_REDIS_STREAM_KEY_PREFIX": namespace,
        "MEMSCHEDULER_STREAM_KEY_PREFIX": namespace,
    })
    for key in ("EPISODE_MAX_TURNS", "EPISODE_IDLE_SECONDS", "SCAN_SECONDS", "FORMATION_COUNT",
                "PUBLISH_STALE_SECONDS", "STAGE_LEASE_SECONDS"):
        settings.pop(f"PROJECT_MEMORY_{key}", None)
    settings["PYTHONPATH"] += f":{here}"
    if thinking_mode := os.getenv("MEMOS_V3_THINKING_MODE"):
        settings["PROJECT_MEMORY_LLM_THINKING_MODE"] = thinking_mode
        settings["PROJECT_MEMORY_JUDGE_LLM_THINKING_MODE"] = thinking_mode
if os.getenv("ADD_VERIFY_FIXTURE"):
    settings.update({
        "OPENAI_API_BASE": "http://127.0.0.1:58111/v1",
        "OPENAI_API_KEY": "local-fixture",
        "MOS_CHAT_MODEL": "local-fixture",
        "MOS_EMBEDDER_API_BASE": "http://127.0.0.1:58111/v1",
        "MOS_EMBEDDER_API_KEY": "local-fixture",
        "MOS_EMBEDDER_MODEL": "local-fixture",
        "PROJECT_MEMORY_POSTGRES_SCHEMA": "add_runtime_fixture",
        "MEMSCHEDULER_REDIS_STREAM_KEY_PREFIX": "addverify:fixture",
        "MEMSCHEDULER_STREAM_KEY_PREFIX": "addverify:fixture",
        "NO_PROXY": "127.0.0.1,localhost",
    })
if proxy := os.getenv("MEMOS_V3_LLM_PROXY"):
    # Every model and embedding call goes through the evaluation usage proxy.
    for key in ("OPENAI_API_BASE", "PROJECT_MEMORY_LLM_API_BASE", "MOS_EMBEDDER_API_BASE"):
        settings[key] = proxy.rstrip("/") + "/v1"
if os.getenv("MEMOS_V3_RETRIEVAL"):
    # Upstream retrieval reads the index Add publishes into the same database.
    settings.update({
        "MEMOS_PROJECT_MEMORY_DSN": settings["PROJECT_MEMORY_POSTGRES_DSN"],
        "MEMOS_PROJECT_MEMORY_TENANT_ID": settings["PROJECT_MEMORY_PROJECT_ID"],
        "MEMOS_PROJECT_MEMORY_INTERNAL": "1",
        "MEMOS_PROJECT_RETRIEVAL_TIME_SCALE": os.getenv("MEMOS_PROJECT_RETRIEVAL_TIME_SCALE", "1"),
    })
clean_prefixes = ("NACOS_", "POSTGRES_", "POLAR_DB_", "NEO4J_", "QDRANT_", "REDIS_",
                  "PROJECT_MEMORY_", "MEMSCHEDULER_", "MOS_", "OPENAI_")
env = {key: value for key, value in os.environ.items() if not key.startswith(clean_prefixes)}
env.update(settings)
os.chdir(repo)
if mode == "openapi":
    env["VIRTUAL_ENV"] = "/Users/junfengran/repos/MemOS/.venv"
    env["PATH"] = f'{env["VIRTUAL_ENV"]}/bin:{env["PATH"]}'
    os.execvpe("make", ["make", "openapi"], env)
os.execve(sys.executable, [
    sys.executable, "-m", "uvicorn", ("replay_app:app" if mode == "replay" else "memos.api.server_api:app"),
    "--host", "127.0.0.1", "--port", str(port),
], env)
