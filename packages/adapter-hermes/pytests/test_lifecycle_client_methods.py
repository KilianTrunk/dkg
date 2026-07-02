"""Unit tests for the new knowledge-asset lifecycle client methods.

Covers payload shaping for ``finalize_assertion``, ``publish_finalized_assertion``,
and ``pull_from`` (CONTRACT §1 stages 3/5 + the pull-from side verb). No live
daemon — only the request body / path the client builds is asserted.
"""

from __future__ import annotations


# -- finalize_assertion -----------------------------------------------------

def test_finalize_threads_author_and_scheme(recording_client):
    client = recording_client
    client.finalize_assertion(
        "my-ka",
        "did:dkg:context-graph:cg1",
        author_agent_address="0xAbC",
        scheme_version=1,
    )
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets/my-ka/wm/finalize"
    assert body == {
        "contextGraphId": "cg1",
        "authorAgentAddress": "0xAbC",
        "schemeVersion": 1,
    }


def test_finalize_minimal_omits_optional_fields(recording_client):
    client = recording_client
    client.finalize_assertion("k", "cg1")
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1"}


def test_finalize_never_sends_pre_signed_attestation(recording_client):
    client = recording_client
    client.finalize_assertion("k", "cg1", author_agent_address="0xabc")
    _, body = client.posts[-1]
    # Hermes relies on node-side signing — no client-side EIP-712.
    assert "preSignedAuthorAttestation" not in body


def test_finalize_url_encodes_name(recording_client):
    client = recording_client
    client.finalize_assertion("a b", "cg1")
    path, _ = client.posts[-1]
    assert path == "/api/knowledge-assets/a%20b/wm/finalize"


def test_finalize_puts_layer_swm_in_body(recording_client):
    # #1116 — the `layer` field must reach the wire (the FakeClient handler tests
    # only prove the tool→client arg pass-through; this pins the actual POST body).
    client = recording_client
    client.finalize_assertion("k", "cg1", layer="swm")
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets/k/wm/finalize"
    assert body == {"contextGraphId": "cg1", "layer": "swm"}


def test_finalize_omits_layer_when_none(recording_client):
    client = recording_client
    client.finalize_assertion("k", "cg1")
    _, body = client.posts[-1]
    assert "layer" not in body


# -- promote_assertion (swm/share) ------------------------------------------

def test_promote_puts_skip_seal_in_body(recording_client):
    # #1116 — `skip_seal=True` must reach the wire as camelCase `skipSeal:true`.
    client = recording_client
    client.promote_assertion("k", "cg1", None, skip_seal=True)
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets/k/swm/share"
    assert body == {"contextGraphId": "cg1", "skipSeal": True}


def test_promote_omits_skip_seal_when_none(recording_client):
    client = recording_client
    client.promote_assertion("k", "cg1", None)
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1"}
    assert "skipSeal" not in body
    assert "entities" not in body


def test_promote_forwards_entities_and_skip_seal_together(recording_client):
    client = recording_client
    client.promote_assertion("k", "cg1", "all", skip_seal=False)
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1", "entities": "all", "skipSeal": False}


# -- publish_finalized_assertion --------------------------------------------

def test_publish_nests_options_and_omits_author_selection(recording_client):
    client = recording_client
    client.publish_finalized_assertion(
        "my-ka",
        "cg1",
        options={"publishEpochs": 2, "clearSharedMemoryAfter": True},
    )
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets/my-ka/vm/publish"
    assert body == {
        "contextGraphId": "cg1",
        "options": {"publishEpochs": 2, "clearSharedMemoryAfter": True},
    }
    # the daemon rejects these on vm/publish — never send them
    assert "authorAgentAddress" not in body
    assert "selection" not in body
    assert "assertionName" not in body


def test_publish_without_options_omits_options_key(recording_client):
    client = recording_client
    client.publish_finalized_assertion("k", "cg1", options=None)
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1"}


def test_publish_empty_options_dict_is_dropped(recording_client):
    client = recording_client
    client.publish_finalized_assertion("k", "cg1", options={})
    _, body = client.posts[-1]
    assert "options" not in body


def test_publish_forwards_sub_graph_name(recording_client):
    client = recording_client
    client.publish_finalized_assertion("k", "cg1", sub_graph_name="sub")
    _, body = client.posts[-1]
    assert body["subGraphName"] == "sub"


# -- pull_from --------------------------------------------------------------

def test_pull_from_requires_layer_in_body(recording_client):
    client = recording_client
    client.pull_from("my-ka", "cg1", "swm", on_conflict="replace")
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets/my-ka/wm/pull-from"
    assert body == {"contextGraphId": "cg1", "layer": "swm", "onConflict": "replace"}


def test_pull_from_minimal_omits_on_conflict(recording_client):
    client = recording_client
    client.pull_from("k", "cg1", "vm")
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1", "layer": "vm"}
