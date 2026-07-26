import json
import platform
import sys
import traceback

try:
    import gkeepapi
except Exception as exc:  # pragma: no cover - exercised through bridge startup
    gkeepapi = None
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


class BridgeError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class KeepBridge:
    def __init__(self):
        self.keep = None
        self.email = None

    def require_gkeepapi(self):
        if gkeepapi is None:
            raise BridgeError(
                "BRIDGE_DEPENDENCY_MISSING",
                f"gkeepapi is not installed: {IMPORT_ERROR}",
                retryable=False,
            )

    def require_auth(self):
        self.require_gkeepapi()
        if self.keep is None:
            raise BridgeError("AUTH_NOT_CONFIGURED", "Google Keep is not authenticated.")

    def ping(self, _params):
        return {"pong": True}

    def version(self, _params):
        self.require_gkeepapi()
        return {
            "python": platform.python_version(),
            "gkeepapi": getattr(gkeepapi, "__version__", "unknown"),
        }

    def configure(self, params):
        self.require_gkeepapi()
        email = str(params.get("email") or "").strip()
        master_token = str(params.get("masterToken") or "").strip()

        if not email or "@" not in email:
            raise BridgeError("AUTH_INVALID_INPUT", "A valid Google account email is required.")
        if not master_token:
            raise BridgeError("AUTH_INVALID_INPUT", "A Google Keep master token is required.")

        keep = gkeepapi.Keep()
        try:
            keep.authenticate(email, master_token)
        except Exception as exc:
            raise BridgeError("AUTH_INVALID", f"Google Keep authentication failed: {exc}") from exc

        self.keep = keep
        self.email = email
        return {"authenticated": True, "email": email}

    def full_pull(self, _params):
        self.require_auth()
        self.keep.sync()
        return {"notes": [serialize_note(note, self.email) for note in self.keep.all()]}

    def create_text(self, params):
        self.require_auth()
        title = str(params.get("title") or "")
        text = str(params.get("text") or "")
        note = self.keep.createNote(title, text)
        apply_common_fields(note, params)
        self.keep.sync()
        return {"note": serialize_note(note, self.email)}

    def update_text(self, params):
        self.require_auth()
        keep_id = str(params.get("keepId") or "").strip()
        if not keep_id:
            raise BridgeError("REMOTE_NOT_FOUND", "A Google Keep note ID is required.")

        note = self.keep.get(keep_id)
        if note is None:
            raise BridgeError("REMOTE_NOT_FOUND", "Google Keep note was not found.")

        patch = params.get("patch") or {}
        if "title" in patch:
            note.title = str(patch["title"] or "")
        if "body" in patch:
            note.text = str(patch["body"] or "")
        if "text" in patch:
            note.text = str(patch["text"] or "")
        apply_common_fields(note, patch)
        self.keep.sync()
        return {"note": serialize_note(note, self.email)}

    def trash(self, params):
        self.require_auth()
        keep_id = str(params.get("keepId") or "").strip()
        if not keep_id:
            raise BridgeError("REMOTE_NOT_FOUND", "A Google Keep note ID is required.")

        note = self.keep.get(keep_id)
        if note is None:
            raise BridgeError("REMOTE_NOT_FOUND", "Google Keep note was not found.")

        note.trash()
        self.keep.sync()
        return {"trashed": True, "keepId": keep_id}


def color_to_string(color):
    if color is None:
        return None
    if isinstance(color, str):
        return color
    return getattr(color, "name", None) or str(color)


def apply_common_fields(note, params):
    if "pinned" in params:
        note.pinned = bool(params["pinned"])
    if "archived" in params:
        note.archived = bool(params["archived"])


def serialize_timestamps(note):
    timestamps = getattr(note, "timestamps", None)
    if not timestamps:
        return {}

    result = {}
    for field in ("created", "updated", "edited"):
        value = getattr(timestamps, field, None)
        if value is not None:
            result[field] = str(value)
    return result


def serialize_list_items(note):
    items = getattr(note, "items", None)
    if not items:
        return None

    serialized = []
    for item in items:
        text = getattr(item, "text", None) or getattr(item, "title", None) or ""
        payload = {
            "id": getattr(item, "id", None),
            "text": text,
            "checked": bool(getattr(item, "checked", False)),
        }
        for field in ("sort", "sortValue", "sortOrder", "order", "position", "rank", "index"):
            value = getattr(item, field, None)
            if value is not None:
                payload[field] = value if isinstance(value, (str, int, float, bool)) else str(value)
        serialized.append(payload)
    return serialized


def serialize_note(note, email):
    timestamps = serialize_timestamps(note)
    list_items = serialize_list_items(note)
    text = getattr(note, "text", "") or ""
    if list_items and not text:
        text = "\n".join(
            f"{'[x]' if item['checked'] else '[ ]'} {item['text']}"
            for item in list_items
            if item["text"]
        )

    updated = timestamps.get("updated") or timestamps.get("edited")
    created = timestamps.get("created")

    return {
        "id": getattr(note, "id", None),
        "title": getattr(note, "title", "") or "",
        "text": text,
        "color": color_to_string(getattr(note, "color", None)),
        "pinned": bool(getattr(note, "pinned", False)),
        "archived": bool(getattr(note, "archived", False)),
        "trashed": bool(getattr(note, "trashed", False)),
        "createdAt": created,
        "updatedAt": updated,
        "lastRemoteEditedAt": updated,
        "accountEmail": email,
        "items": list_items,
    }


METHODS = {
    "bridge.ping": KeepBridge.ping,
    "bridge.version": KeepBridge.version,
    "auth.configure": KeepBridge.configure,
    "sync.fullPull": KeepBridge.full_pull,
    "notes.createText": KeepBridge.create_text,
    "notes.updateText": KeepBridge.update_text,
    "notes.trash": KeepBridge.trash,
}


def error_response(request_id, exc):
    if isinstance(exc, BridgeError):
        return {
            "id": request_id,
            "ok": False,
            "error": {
                "code": exc.code,
                "message": str(exc),
                "retryable": exc.retryable,
            },
        }

    traceback.print_exc(file=sys.stderr)
    return {
        "id": request_id,
        "ok": False,
        "error": {
            "code": "UNKNOWN",
            "message": str(exc),
            "retryable": False,
        },
    }


def main():
    bridge = KeepBridge()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request.get("id")
            method = request.get("method")
            params = request.get("params") or {}
            handler = METHODS.get(method)
            if handler is None:
                raise BridgeError("BRIDGE_METHOD_NOT_FOUND", f"Unknown bridge method: {method}")
            response = {"id": request_id, "ok": True, "result": handler(bridge, params)}
        except Exception as exc:
            response = error_response(request.get("id") if "request" in locals() else None, exc)

        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    main()
