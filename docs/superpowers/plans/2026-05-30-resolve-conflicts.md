# Resolve Git Conflicts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve merge conflicts in `antigravity_client.py` and `.stack-urls.md` by integrating semaphore logic, improving exception handling, and updating tracking URLs.

**Architecture:** Integrate `asyncio.Semaphore` for concurrency control while maintaining message validation and robust `__aexit__` cleanup.

**Tech Stack:** Python, asyncio, Git

---

### Task 1: Resolve conflicts in `backend/src/opencode_antigravity/antigravity_client.py`

**Files:**
- Modify: `backend/src/opencode_antigravity/antigravity_client.py`

- [ ] **Step 1: Resolve Conflict 1 (stream_chat start)**
Merge semaphore usage with message validation.

```python
<<<<<<< HEAD
        async with _get_semaphore():
            self.agent_enter_attempt_count += 1
            if self.fail_next_enter:
                self.fail_next_enter = False
                raise RuntimeError("cold-start failure")
=======
        # Validate/normalize just like live mode
        _ = fold_messages_to_prompt(messages)

        self.agent_enter_attempt_count += 1
        if self.fail_next_enter:
            self.fail_next_enter = False
            raise RuntimeError("cold-start failure")
>>>>>>> master
```

Resolution:
```python
        # Validate/normalize just like live mode
        _ = fold_messages_to_prompt(messages)

        async with _get_semaphore():
            self.agent_enter_attempt_count += 1
            if self.fail_next_enter:
                self.fail_next_enter = False
                raise RuntimeError("cold-start failure")
```

- [ ] **Step 2: Resolve Conflict 2 (stream_chat chat loop)**
Adopt robust `exc_info` and `__aexit__` call from master.

```python
<<<<<<< HEAD
            try:
                response = await agent.chat(prompt)
                async for token in response:
                    if token:
                        yield token
            except Exception as exc:
                raise classify_sdk_error(exc) from exc
            finally:
                _ = await agent_cm.__aexit__(None, None, None)
=======
        exc_info: tuple[
            type[BaseException] | None, BaseException | None, TracebackType | None
        ] = (None, None, None)
        try:
            response = await agent.chat(prompt)
            async for token in response:
                if token:
                    yield token
        except Exception as exc:
            exc_info = (type(exc), exc, exc.__traceback__)
            raise classify_sdk_error(exc) from exc
        finally:
            _ = await agent_cm.__aexit__(*exc_info)
>>>>>>> master
```

Resolution:
```python
            exc_info: tuple[
                type[BaseException] | None, BaseException | None, TracebackType | None
            ] = (None, None, None)
            try:
                response = await agent.chat(prompt)
                async for token in response:
                    if token:
                        yield token
            except Exception as exc:
                exc_info = (type(exc), exc, exc.__traceback__)
                raise classify_sdk_error(exc) from exc
            finally:
                _ = await agent_cm.__aexit__(*exc_info)
```

- [ ] **Step 3: Verify syntax**
Run: `ruff check backend/src/opencode_antigravity/antigravity_client.py`

---

### Task 2: Resolve conflicts in `docs/superpowers/plans/.stack-urls.md`

**Files:**
- Modify: `docs/superpowers/plans/.stack-urls.md`

- [ ] **Step 1: Resolve Conflict**
Keep the new URL from master.

```markdown
<<<<<<< HEAD
=======
- T2.4: https://github.com/yohi/opencode-antigravity-plugin/pull/45
>>>>>>> master
```

Resolution:
```markdown
- T2.4: https://github.com/yohi/opencode-antigravity-plugin/pull/45
```

---

### Task 3: Validation and Staging

- [ ] **Step 1: Run Python tests**
Run: `pytest tests/python/unit/test_antigravity_client.py`
Expected: PASS

- [ ] **Step 2: Run Concurrency tests**
Run: `pytest tests/python/integration/test_antigravity_client_concurrency.py`
Expected: PASS (Verifies semaphore is working)

- [ ] **Step 3: Stage changes**
Run: `git add backend/src/opencode_antigravity/antigravity_client.py docs/superpowers/plans/.stack-urls.md`

- [ ] **Step 4: Check status**
Run: `git status`
Expected: All conflicts resolved, files staged.
