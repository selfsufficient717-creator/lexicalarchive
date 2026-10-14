"""Real-browser integration checks with deterministic service fixtures.

Run: python tests/browser_smoke.py
Requires Python Playwright and Chromium (CHROMIUM_PATH overrides the executable).
The runner uses an existing app on BROWSER_BASE_URL, or starts its own local static
server. Every Supabase/AI request is mocked; this does not validate AI quality or
live email delivery. Screenshots are written to /tmp/lexical-trove-*.png.
"""

from __future__ import annotations

import base64
import copy
import functools
import http.server
import json
import os
from pathlib import Path
import threading
import time
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / "tests/browser_fixtures.json").read_text())
SUPABASE = "https://test-project.supabase.co"
USER = {"id": "fixture-user", "email": "learner@example.test"}
PUBLIC_KEY = "sb_publishable_browser_fixture_only"
TOKEN = "fixture-access-token"
REFRESH = "fixture-refresh-token"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8ZkAAAAASUVORK5CYII=")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class MockServices:
    def __init__(self, base_url, configured=True, auth_valid=True):
        self.base_url = base_url.rstrip("/")
        self.configured = configured
        self.auth_valid = auth_valid
        self.items = []
        self.attempts = []
        self.profile = None
        self.requests = []
        self.unexpected = []
        self.lookup_delays = {}

    def install(self, context):
        context.route("**/*", self.route)

    def calls(self, path, method=None):
        return [request for request in self.requests if urlparse(request["url"]).path == path and (method is None or request["method"] == method)]

    def fulfill(self, route, data=None, status=200):
        route.fulfill(status=status, content_type="application/json", body=json.dumps(data))

    def route(self, route):
        request = route.request
        parsed = urlparse(request.url)
        if parsed.path.endswith("/config.js") and request.url.startswith(self.base_url):
            config = {"apiBaseUrl": self.base_url, "supabaseUrl": SUPABASE, "supabaseAnonKey": PUBLIC_KEY} if self.configured else {"apiBaseUrl": "", "supabaseUrl": "", "supabaseAnonKey": ""}
            route.fulfill(status=200, content_type="text/javascript", body="export const CONFIG = " + json.dumps(config) + ";")
            return
        is_supabase = request.url.startswith(SUPABASE + "/")
        is_api = request.url.startswith(self.base_url + "/api/")
        if not is_supabase and not is_api:
            if request.url.startswith(self.base_url + "/"):
                route.continue_()
            else:
                self.unexpected.append(request.url)
                route.abort()
            return
        body = None
        if request.headers.get("content-type", "").startswith("application/json") and request.post_data:
            body = request.post_data_json
        self.requests.append({"url": request.url, "method": request.method, "body": body, "headers": request.headers})
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/auth/v1/user":
            self.fulfill(route, USER if self.auth_valid else {"message": "Invalid link"}, 200 if self.auth_valid else 401)
        elif path == "/auth/v1/token":
            self.fulfill(route, {"message": "Invalid refresh token"}, 401)
        elif path in ("/auth/v1/otp", "/auth/v1/logout"):
            self.fulfill(route, {})
        elif path == "/rest/v1/items":
            if request.method == "GET":
                self.fulfill(route, self.items)
            elif request.method == "POST":
                self.items.append(body)
                self.fulfill(route, None, 204)
            elif request.method == "PATCH":
                row = next(row for row in self.items if row["id"] == query["id"][0][3:])
                row.update(body)
                self.fulfill(route, [row])
            else:
                self.unexpected.append(request.url)
                self.fulfill(route, {"message": "Unexpected fixture request"}, 500)
        elif path == "/rest/v1/profiles":
            if request.method == "POST":
                self.profile = body
            self.fulfill(route, [self.profile] if self.profile else [])
        elif path == "/rest/v1/attempts":
            item_id = query["item_id"][0][3:]
            mode = query["mode"][0][3:]
            self.fulfill(route, [attempt for attempt in self.attempts if attempt["item_id"] == item_id and attempt["mode"] == mode])
        elif path.startswith("/storage/v1/object/public/avatars/"):
            route.fulfill(status=200, content_type="image/png", body=PNG)
        elif path.startswith("/storage/v1/object/avatars/"):
            self.fulfill(route, {"Key": path})
        elif path == "/api/lexicon":
            # Delay the mocked response while browser timers remain active, so
            # queued pastes and navigation can exercise genuine in-flight UI.
            delay = self.lookup_delays.pop(body["text"], 0)
            if delay:
                time.sleep(delay)
            payload = copy.deepcopy(next((item for item in FIXTURES["items"] if item["term"] == body["text"]), FIXTURES["items"][0]))
            payload["term"] = body["text"]
            payload["language"] = body["language"]
            self.fulfill(route, payload)
        elif path == "/api/feedback":
            previous = [attempt for attempt in self.attempts if attempt["item_id"] == body["itemId"] and attempt["mode"] == body["mode"]]
            if len(previous) >= 3:
                self.fulfill(route, {"error": {"message": "All three attempts are complete."}}, 409)
                return
            feedback = copy.deepcopy(FIXTURES["feedback"])
            if not previous:
                feedback["comparison"] = None
            response = body.get("response", "A ceasefire gives people time to rebuild trust and discuss a lasting agreement.")
            if body["mode"] == "speaking":
                feedback["transcript"] = response
                feedback["criteria"] = [
                    {"name": "Fluency", "score": 4, "comment": "The speech flows with few pauses."},
                    {"name": "Idea organization", "score": 4, "comment": "The main idea and support are connected."},
                    {"name": "Lexical item usage", "score": 4, "comment": "The lexical item is accurate."},
                    {"name": "Pronunciation", "score": 3, "comment": "The words are understandable."},
                ]
            attempt = {"id": f"attempt-{len(self.attempts) + 1}", "user_id": USER["id"], "item_id": body["itemId"], "mode": body["mode"], "attempt_number": len(previous) + 1, "prompt": body["prompt"], "response": response, "feedback": feedback}
            self.attempts.append(attempt)
            self.fulfill(route, {**feedback, "attemptId": attempt["id"], "attemptNumber": attempt["attempt_number"]})
        else:
            self.unexpected.append(request.url)
            self.fulfill(route, {"message": "Unexpected fixture request"}, 500)


def signed_in_url(base_url):
    return base_url + "/#access_token=" + TOKEN + "&refresh_token=" + REFRESH + "&expires_in=3600&type=magiclink"


def new_page(browser, mock, mobile=False):
    context = browser.new_context(viewport={"width": 390, "height": 844} if mobile else {"width": 1440, "height": 1000}, permissions=["microphone"])
    mock.install(context)
    page = context.new_page()
    page.set_default_timeout(10000)
    return context, page


def navigate_signed_in(page, mock):
    page.goto(signed_in_url(mock.base_url))
    expect(page.locator("#account-label")).to_have_text("My profile" if not mock.profile else mock.profile["display_name"])
    expect(page.locator("#library-count")).to_have_text(str(len(mock.items)))


def select_studio(page, mode):
    page.locator('nav [data-view="practice"]').click()
    page.locator("#practice-item").select_option(label="ceasefire")
    page.locator(f'[data-mode="{mode}"]').click()


def main():
    configured_base = os.environ.get("BROWSER_BASE_URL")
    server = None
    if configured_base:
        base_url = configured_base.rstrip("/")
    else:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(ROOT)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base_url = f"http://127.0.0.1:{server.server_address[1]}"
    passed = 0
    all_mocks = []

    def check(name):
        nonlocal passed
        passed += 1
        print(f"PASS {passed:02d}: {name}", flush=True)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"), headless=True, args=["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])

            unconfigured = MockServices(base_url, configured=False)
            all_mocks.append(unconfigured)
            context, page = new_page(browser, unconfigured)
            page.goto(base_url + "/")
            expect(page.locator("#library-count")).to_have_text("0")
            page.locator('nav [data-view="library"]').click()
            expect(page.locator("#library-cards article")).to_have_count(0)
            expect(page.locator("#library-empty")).to_be_visible()
            check("fresh trove is empty; no fixed vocabulary list")
            page.locator('nav [data-view="discover"]').click()
            page.locator("#lexical-input").fill("ceasefire")
            page.locator("#language").fill("Uzbek")
            page.locator("#lookup-button").click()
            expect(page.locator("#lookup-status")).to_contain_text("learning service is being connected")
            page.locator("#account-button").click()
            page.locator("#email").fill("learner@example.test")
            page.locator("#signin-form button").click()
            expect(page.locator("#signin-status")).to_contain_text("Email sign-in is not connected")
            assert not unconfigured.requests
            check("unconfigured lookup and email give actionable graceful messages")
            context.close()

            anonymous = MockServices(base_url)
            all_mocks.append(anonymous)
            context, page = new_page(browser, anonymous)
            page.goto(base_url + "/")
            page.locator("#account-button").click()
            page.locator("#email").fill("learner@example.test")
            page.locator("#signin-form button").click()
            expect(page.locator("#signin-status")).to_contain_text("Check your inbox")
            calls = anonymous.calls("/auth/v1/otp", "POST")
            assert len(calls) == 1
            assert calls[0]["body"]["email"] == USER["email"]
            assert calls[0]["body"]["create_user"] is True
            assert calls[0]["body"]["options"]["emailRedirectTo"] == base_url + "/"
            assert parse_qs(urlparse(calls[0]["url"]).query)["redirect_to"] == [base_url + "/"]
            check("email-only magic link uses current website redirect and public key")
            context.close()

            rejected = MockServices(base_url, auth_valid=False)
            all_mocks.append(rejected)
            context, page = new_page(browser, rejected)
            page.goto(signed_in_url(base_url))
            expect(page.locator("#notice")).to_contain_text("email sign-in link has expired")
            expect(page.locator("#account-label")).to_have_text("Sign in")
            assert "access_token" not in page.url and "refresh_token" not in page.url
            assert page.evaluate("localStorage.getItem('lexical-trove-session-v1')") is None
            check("invalid confirmation link is removed and cannot create an account session")
            context.close()

            mock = MockServices(base_url)
            all_mocks.append(mock)
            context, page = new_page(browser, mock)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            navigate_signed_in(page, mock)
            assert "access_token" not in page.url and "refresh_token" not in page.url
            verified = mock.calls("/auth/v1/user")
            assert len(verified) == 1
            assert verified[0]["headers"]["authorization"] == "Bearer " + TOKEN
            check("confirmation credentials consumed, removed from URL, and user verified")

            page.locator("#language").fill("Uzbek")
            page.locator("#lexical-input").fill("ceasefire")
            page.locator("#lexical-input").dispatch_event("paste")
            expect(page.locator(".entry-title")).to_have_text("ceasefire")
            page.wait_for_timeout(1000)
            calls = mock.calls("/api/lexicon", "POST")
            assert len(calls) == 1 and calls[0]["body"]["text"] == "ceasefire"
            assert calls[0]["body"]["language"] == "Uzbek"
            assert len(mock.items) == 1
            expect(page.locator(".entry-definition")).to_have_text(FIXTURES["items"][0]["definition"])
            expect(page.locator(".examples li")).to_have_count(2)
            check("paste automatically looks up once, translates, and saves a word")

            phrase = FIXTURES["items"][1]["term"]
            page.locator("#lexical-input").fill(phrase)
            page.locator("#lookup-button").click()
            expect(page.locator(".entry-title")).to_have_text(phrase)
            expect(page.locator("#library-count")).to_have_text("2")
            expect(page.locator("#entry-panel img")).to_have_count(0)
            assert page.evaluate("window.injected === undefined")
            assert mock.items[1]["payload"]["term"] == phrase
            page.locator('nav [data-view="library"]').click()
            expect(page.locator("#library-cards article")).to_have_count(2)
            expect(page.locator("#library-cards img")).to_have_count(0)
            check("phrases/idioms save equally, and HTML-like text remains safe literal text")

            page.locator("#account-button").click()
            page.locator("#display-name").fill("Trove Learner")
            page.get_by_role("button", name="Save my profile", exact=True).click()
            expect(page.locator("#account-content .form-status")).to_contain_text("Profile saved")
            assert mock.profile["display_name"] == "Trove Learner" and mock.profile["avatar_url"] is None
            page.get_by_label("Choose a profile photo").set_input_files({"name": "portrait.png", "mimeType": "image/png", "buffer": PNG})
            page.get_by_role("button", name="Save my profile", exact=True).click()
            expect(page.locator("#header-avatar img")).to_have_count(1)
            assert len(mock.calls("/rest/v1/profiles", "POST")) == 2
            assert mock.profile["avatar_url"].startswith(SUPABASE + "/storage/v1/object/public/avatars/fixture-user/")
            assert any("/storage/v1/object/avatars/" in call["url"] for call in mock.requests)
            page.locator("#close-account").click()
            check("profile name saves with optional verified image upload")

            select_studio(page, "quiz")
            labels = []
            for exercise_number in range(8):
                labels.append(page.locator(".practice-topline").inner_text())
                if exercise_number == 6:
                    expect(page.locator(".practice-card .badge")).to_have_count(0)
                choices = page.locator(".quiz-options button")
                if choices.count():
                    expect(page.get_by_role("button", name="Check answer", exact=True)).to_be_disabled()
                    choices.first.click()
                    page.get_by_role("button", name="Check answer", exact=True).click()
                    expect(page.locator(".quiz-result")).to_be_visible()
                else:
                    page.get_by_role("textbox", name="Your answer", exact=True).fill("a paraphrase to compare")
                    page.get_by_role("button", name="Reveal & compare", exact=True).click()
                    expect(page.locator(".quiz-result")).to_contain_text("Reference answer")
                    page.get_by_role("button", name="I remembered it", exact=True).click()
                page.get_by_role("button", name="Finish this round →" if exercise_number == 7 else "Next exercise →", exact=True).click()
            expect(page.locator("#practice-content")).to_contain_text("exercises answered correctly")
            assert len(set(labels)) == 8
            assert next(item for item in mock.items if item["payload"]["term"] == "ceasefire")["review"]["reviewCount"] == 1
            check("eight quiz styles work, choice checking and recall reveal update spaced review")

            page.locator('[data-mode="match"]').click()
            for relation in ("meaning", "synonym", "antonym"):
                page.get_by_label("Matching relation").select_option(relation)
                expect(page.locator(".match-column").nth(0).locator("button")).to_have_count(2)
                for item in FIXTURES["items"]:
                    left = page.locator(".match-column").nth(0).get_by_role("button", name=item["term"], exact=True)
                    left.click()
                    right_texts = [item["definition"]] if relation == "meaning" else item[relation + "s"]
                    for text in right_texts:
                        target = page.locator(".match-column").nth(1).get_by_role("button", name=text, exact=True)
                        if target.count():
                            target.click()
                            break
                    expect(left).to_be_disabled()
                expect(page.locator("#practice-content .form-status")).to_have_text("All connected. Nicely done.")
            check("true matching rounds pair two collected meanings, synonyms, and antonyms")

            page.locator('[data-mode="writing"]').click()
            for attempt_number in range(1, 4):
                response = f"A ceasefire helps a community rebuild trust because families can return home safely. Revision {attempt_number} explains how neighbors can discuss shared goals and plan a lasting agreement together."
                page.get_by_label("Your writing response").fill(response)
                page.get_by_role("button", name="Get writing feedback →" if attempt_number == 1 else "Assess my revision →", exact=True).click()
                expect(page.locator(".feedback").first.locator(".eyebrow")).to_have_text(f"FEEDBACK · ATTEMPT {attempt_number}")
                feedback = page.locator(".feedback").first
                assert feedback.locator("h3").first.inner_text() == "Overall impression"
                expect(feedback.locator(".criterion")).to_have_count(5)
                expect(feedback.locator(".mistake-list li")).to_have_count(1)
                mistake_labels = feedback.locator(".mistake-list li strong").all_text_contents()
                assert mistake_labels == ["Mistake ", "Why? ", "How to improve "], mistake_labels
                assert feedback.evaluate("node => Boolean(node.querySelector('.overall').compareDocumentPosition(node.querySelector('.mistake-list')) & Node.DOCUMENT_POSITION_FOLLOWING)")
                assert feedback.evaluate("node => Boolean(node.querySelector('.mistake-list').compareDocumentPosition(node.querySelector('.criteria-grid')) & Node.DOCUMENT_POSITION_FOLLOWING)")
                if attempt_number > 1:
                    expect(feedback.locator(".comparison")).to_be_visible()
                if attempt_number < 3:
                    page.reload()
                    expect(page.locator("#account-label")).to_have_text("Trove Learner")
                    select_studio(page, "writing")
                    expect(page.get_by_label("Your writing response")).to_have_value(response)
            expect(page.locator("#practice-content")).to_contain_text("All three attempts are complete")
            expect(page.get_by_label("Your writing response")).to_have_count(0)
            assert len([attempt for attempt in mock.attempts if attempt["mode"] == "writing"]) == 3
            assert all(len(call["body"]["previousAttempts"]) == i for i, call in enumerate(mock.calls("/api/feedback", "POST")))
            page.screenshot(path="/tmp/lexical-trove-writing-desktop.png", full_page=True)
            check("writing first response plus two revisions persist across reload, ordered feedback, hard three-attempt cap")

            page.locator('[data-mode="speaking"]').click()
            for attempt_number in range(1, 4):
                expect(page.get_by_role("button", name="Get speaking feedback →" if attempt_number == 1 else "Assess my new recording →", exact=True)).to_be_disabled()
                page.get_by_role("button", name="● Start recording", exact=True).click()
                expect(page.get_by_role("button", name="■ Stop recording", exact=True)).to_be_enabled()
                page.wait_for_timeout(1500)
                page.get_by_role("button", name="■ Stop recording", exact=True).click()
                expect(page.get_by_label("Listen to your recording")).to_be_visible()
                page.get_by_role("button", name="Get speaking feedback →" if attempt_number == 1 else "Assess my new recording →", exact=True).click()
                expect(page.locator(".feedback").first.locator(".eyebrow")).to_have_text(f"FEEDBACK · ATTEMPT {attempt_number}")
                expect(page.locator(".feedback").first.locator(".criteria-grid")).to_contain_text("Pronunciation")
                expect(page.locator(".feedback").first).to_contain_text("Read the recording transcript")
            expect(page.locator("#practice-content")).to_contain_text("All three attempts are complete")
            assert len([attempt for attempt in mock.attempts if attempt["mode"] == "speaking"]) == 3
            speaking_calls = [call for call in mock.calls("/api/feedback", "POST") if call["body"]["mode"] == "speaking"]
            assert [len(call["body"]["previousAttempts"]) for call in speaking_calls] == [0, 1, 2]
            for call in speaking_calls:
                audio = call["body"]["audio"]
                raw = base64.b64decode(audio["base64"])
                assert audio["format"] == "wav" and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"
                assert call["body"]["durationSeconds"] >= 1
            check("real fake-device microphone records WAV, preview, feedback and two speaking revisions")

            page.locator('nav [data-view="discover"]').click()
            page.screenshot(path="/tmp/lexical-trove-desktop.png", full_page=True)
            assert not errors, errors
            context.close()

            pending_mock = MockServices(base_url)
            pending_mock.items = copy.deepcopy(mock.items)
            all_mocks.append(pending_mock)
            context, page = new_page(browser, pending_mock)
            navigate_signed_in(page, pending_mock)
            ceasefire_id = next(item["id"] for item in pending_mock.items if item["payload"]["term"] == "ceasefire")
            pending_mock.lookup_delays["under the weather"] = 0.8
            page.locator("#language").fill("Uzbek")
            page.locator("#lexical-input").fill("under the weather")
            page.evaluate("""id => {
                setTimeout(() => {
                    document.querySelector('nav [data-view="practice"]').click();
                    const select = document.querySelector('#practice-item');
                    select.value = id;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }, 150);
                document.querySelector('#capture-form').requestSubmit();
            }""", ceasefire_id)
            expect(page.locator("#library-count")).to_have_text("3")
            expect(page.locator("#practice-view")).to_be_visible()
            expect(page.locator("#practice-item")).to_have_value(ceasefire_id)
            expect(page.locator(".practice-card .badge")).to_have_text("ceasefire")
            check("background lookup completion preserves the item chosen for practice")

            page.locator('nav [data-view="discover"]').click()
            pending_mock.lookup_delays["first queued phrase"] = 1.5
            before_lookup = len(pending_mock.calls("/api/lexicon", "POST"))
            page.evaluate("""() => {
                const input = document.querySelector('#lexical-input');
                input.value = 'first queued phrase';
                input.dispatchEvent(new Event('paste', { bubbles: true }));
                setTimeout(() => {
                    input.value = 'latest queued idiom';
                    input.dispatchEvent(new Event('paste', { bubbles: true }));
                }, 1100);
            }""")
            expect(page.locator(".entry-title")).to_have_text("latest queued idiom", timeout=15000)
            queued_calls = pending_mock.calls("/api/lexicon", "POST")[before_lookup:]
            assert [call["body"]["text"] for call in queued_calls] == ["first queued phrase", "latest queued idiom"]
            expect(page.locator("#library-count")).to_have_text("5")
            page.wait_for_timeout(1000)
            assert len(pending_mock.calls("/api/lexicon", "POST")) == before_lookup + 2
            check("pasting during an in-flight lookup queues the latest phrase exactly once")
            context.close()

            context, page = new_page(browser, mock, mobile=True)
            navigate_signed_in(page, mock)
            page.screenshot(path="/tmp/lexical-trove-mobile.png", full_page=True)
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            page.locator('nav [data-view="library"]').click()
            expect(page.locator("#library-cards article")).to_have_count(2)
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            select_studio(page, "writing")
            expect(page.locator("#practice-content")).to_contain_text("All three attempts are complete")
            page.screenshot(path="/tmp/lexical-trove-writing-mobile.png", full_page=True)
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            check("390px mobile discovery/library/studio have no horizontal overflow, final attempts survive reload")
            context.close()
            assert not [url for mocked in all_mocks for url in mocked.unexpected], [url for mocked in all_mocks for url in mocked.unexpected]
            assert all(call["headers"].get("authorization") == "Bearer " + TOKEN for call in mock.requests if "/api/" in call["url"])
            check("no unexpected external requests or browser errors; AI requests carry verified session")
            browser.close()
            print(f"\n{passed} browser integration checks passed. Supabase and AI responses were deterministic fixtures; no live provider calls.", flush=True)
    finally:
        if server:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
