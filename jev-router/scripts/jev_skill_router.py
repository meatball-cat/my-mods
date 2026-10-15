#!/usr/bin/env python3
"""Ask Jev (TypeSafe System One) which skill fits a prompt, or how complex a subagent task is.

  jev_skill_router.py --json <prompt>        -> {"choice", "confidence"}
  jev_skill_router.py --complexity <task>    -> {"score", "confidence"}

Pass "-" as the text to read it from stdin (the mod does, so prompts stay out of `ps`).

Standard library only. The API key comes from TYPESAFE_API_KEY, else the macOS
keychain item the Jev MCP server uses (service ai.typesafe.api). It is never
printed, logged or written anywhere. On any error: exit 1, print nothing.
"""
import glob
import json
import os
import ssl
import subprocess
import sys
import time
import urllib.request

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
TIMEOUT_S = 5
KEYCHAIN_SERVICE = "ai.typesafe.api"
LOG = os.path.expanduser("~/.claude/jev_log.jsonl")
MAX_STATE = 8000
MAX_DESCRIPTION = 400

COMPLEXITY_LEVELS = [
    "Mechanical lookup: find files, grep for a symbol, list or read something and report it back.",
    "Routine work with clear steps: a small known-cause fix, a summary of a few files, running tests and reporting.",
    "Multi-step work that needs judgment: a feature across several files, debugging with an unknown cause, comparing approaches.",
    "Deep reasoning: architecture or design review, security audit, subtle concurrency or correctness analysis, hard open-ended research.",
]


def api_key():
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        return key
    if sys.platform != "darwin":
        return ""
    account = os.environ.get("USER", "")
    argv = ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE]
    argv += (["-a", account] if account else []) + ["-w"]
    out = subprocess.run(argv, capture_output=True, text=True, timeout=2)
    return out.stdout.strip() if out.returncode == 0 else ""


def tls_context():
    """Default verification, plus the macOS trust roots: python.org builds ship no CA bundle."""
    ctx = ssl.create_default_context()
    if sys.platform == "darwin":
        out = subprocess.run(["/usr/bin/security", "find-certificate", "-a", "-p",
                              "/System/Library/Keychains/SystemRootCertificates.keychain",
                              "/Library/Keychains/System.keychain"],
                             capture_output=True, text=True, timeout=2)
        if out.returncode == 0 and "BEGIN CERTIFICATE" in out.stdout:
            ctx.load_verify_locations(cadata=out.stdout)
    return ctx


def ask(state, question):
    key = api_key()
    if not key:
        raise RuntimeError("no key")
    body = json.dumps({"state": state, "model": MODEL, "questions": {"answer": question}}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT_S, context=tls_context()) as resp:
        answer = json.load(resp)["answers"]["answer"]
    if answer.get("type") != question["type"]:
        raise RuntimeError("wrong answer type")
    return answer


def frontmatter(path):
    """name and description from a SKILL.md's YAML front matter (plain, quoted or folded)."""
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    if not lines or lines[0].strip() != "---":
        return {}
    fields, key, block = {}, None, []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if key and (line.startswith((" ", "\t")) or not line.strip()):
            block.append(line.strip())
            continue
        if key:
            fields[key] = " ".join(b for b in block if b)
            key, block = None, []
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if v in (">", "|", ">-", "|-", ">+", "|+"):
            key = k
        else:
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            fields[k] = v
    if key:
        fields[key] = " ".join(b for b in block if b)
    return fields


def skills():
    roots = [os.path.expanduser("~/.claude/skills"), os.path.join(os.getcwd(), ".claude", "skills")]
    found = {}
    for root in roots:
        # <root>/<skill>/SKILL.md, and the claude.ai bundles under <root>/synced/<bundle>/<skill>/.
        paths = sorted(glob.glob(os.path.join(root, "*", "SKILL.md")))
        paths += sorted(glob.glob(os.path.join(root, "synced", "*", "*", "SKILL.md")))
        for path in paths:
            try:
                meta = frontmatter(path)
            except (OSError, UnicodeDecodeError):
                continue
            name = (meta.get("name") or os.path.basename(os.path.dirname(path))).strip()
            if not name or name == "none" or name in found:
                continue
            found[name] = (meta.get("description") or name)[:MAX_DESCRIPTION]
    return found


def pick_skill(prompt):
    options = skills()
    if not options:
        raise RuntimeError("no skills")
    options["none"] = "No skill clearly fits: small talk, a quick question, or ordinary coding that needs no special workflow."
    answer = ask(prompt[:MAX_STATE], {
        "type": "choice",
        "instructions": "The state is a user's request to a coding assistant. Which skill should the assistant load "
                        "to handle it? Pick 'none' unless one skill clearly fits the request.",
        "criteria": options,
    })
    if answer["choice"] not in options:
        raise RuntimeError("choice not among the options")
    result = {"choice": answer["choice"], "confidence": float(answer["confidence"])}
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **result}) + "\n")
    return result


def complexity(task):
    answer = ask(task[:MAX_STATE], {
        "type": "score",
        "instructions": "The state is a task handed to a subagent. How much reasoning does doing it well take?",
        "criteria": COMPLEXITY_LEVELS,
    })
    # Levels come back 0-based ("0".."3"); report the most likely one, 1-based.
    probs = answer.get("probabilities")
    if isinstance(probs, dict) and probs:
        level = int(max(probs, key=lambda k: probs[k])) + 1
    else:
        level = int(round(float(answer["score"]))) + 1
    if not 1 <= level <= len(COMPLEXITY_LEVELS):
        raise RuntimeError("score out of range")
    return {"score": level, "confidence": float(answer["confidence"])}


def main(argv):
    if len(argv) != 2 or argv[0] not in ("--json", "--complexity"):
        return 2
    text = sys.stdin.read() if argv[1] == "-" else argv[1]
    if not text.strip():
        return 2
    result = pick_skill(text) if argv[0] == "--json" else complexity(text)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        code = main(sys.argv[1:])
    except Exception:
        code = 1
    sys.exit(code)
