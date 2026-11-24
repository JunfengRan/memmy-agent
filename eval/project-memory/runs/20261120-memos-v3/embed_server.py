import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

root = Path.home() / ".memmy/memory-service/embedding-models/Xenova/all-MiniLM-L6-v2"
tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))
tokenizer.enable_truncation(max_length=256)
tokenizer.enable_padding()
options = ort.SessionOptions()
options.intra_op_num_threads = 2
options.inter_op_num_threads = 1
inference = ort.InferenceSession(str(root / "onnx/model_quantized.onnx"), sess_options=options)
names = {value.name for value in inference.get_inputs()}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        texts = request["input"]
        if isinstance(texts, str):
            texts = [texts]
        tokens = tokenizer.encode_batch(texts)
        ids = np.array([token.ids for token in tokens], dtype=np.int64)
        mask = np.array([token.attention_mask for token in tokens], dtype=np.int64)
        types = np.array([token.type_ids for token in tokens], dtype=np.int64)
        tensors = {"input_ids":ids, "attention_mask":mask, "token_type_ids":types}
        encoded = inference.run(None, {name:tensors[name] for name in names})[0]
        weights = mask[:, :, None]
        pooled = (encoded * weights).sum(axis=1) / np.maximum(weights.sum(axis=1), 1)
        vectors = pooled / np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
        payload = json.dumps({
            "object":"list", "model":"all-MiniLM-L6-v2",
            "data":[{"object":"embedding","index":i,"embedding":v.tolist()} for i,v in enumerate(vectors)],
            "usage":{"prompt_tokens":int(mask.sum()),"total_tokens":int(mask.sum())},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


ThreadingHTTPServer(("127.0.0.1",58112),Handler).serve_forever()
