import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.api.playlists import PlaylistUpdate


def test_public_playlist_can_rename_and_clean_title():
    payload = PlaylistUpdate(title="  New Title  ")
    updates = payload.prepare_updates(was_public=True)
    assert updates == {"title": "New Title"}


def test_public_playlist_can_update_handle():
    payload = PlaylistUpdate(handle="@My_Handle")
    updates = payload.prepare_updates(was_public=True)
    assert updates["handle"] == "my_handle"


def test_public_playlist_can_become_private_and_clears_handle():
    payload = PlaylistUpdate(is_public=False)
    updates = payload.prepare_updates(was_public=True)
    assert updates == {"is_public": False, "handle": None}


def test_private_playlist_only_allows_title_update():
    payload = PlaylistUpdate(title="Rename")
    updates = payload.prepare_updates(was_public=False)
    assert updates == {"title": "Rename"}


def test_private_playlist_requires_public_before_handle():
    payload = PlaylistUpdate(handle="new")
    with pytest.raises(ValueError):
        payload.prepare_updates(was_public=False)


def test_private_playlist_can_become_public():
    payload = PlaylistUpdate(is_public=True)
    updates = payload.prepare_updates(was_public=False)
    assert updates == {"is_public": True}


def test_private_playlist_becomes_public_with_handle():
    payload = PlaylistUpdate(is_public=True, handle="My_Handle")
    updates = payload.prepare_updates(was_public=False)
    assert updates["is_public"] is True
    assert updates["handle"] == "my_handle"


def test_update_requires_changes():
    payload = PlaylistUpdate()
    with pytest.raises(ValueError):
        payload.prepare_updates(was_public=True)


def test_invalid_handle_is_rejected():
    payload = PlaylistUpdate(handle="bad handle!")
    with pytest.raises(ValueError):
        payload.prepare_updates(was_public=True)
