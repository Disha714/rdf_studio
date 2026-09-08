"""Regression: a nameless newProducts entry crashed apply_proposal with KeyError('name'),
which _guard rendered for the user as the bare message "'name'". Filtering where the
model's output becomes the stored proposal keeps apply_proposal and revert_proposal - both
of which index p["name"] directly - safe by construction."""
from app.ai.modify import _slug, _usable_products


def test_nameless_products_are_dropped():
    kept = _usable_products([
        {"name": "route code table", "role": "input"},
        {"role": "input"},                  # model omitted `name` entirely
        {"name": "", "role": "output"},     # empty
        {"name": "   ", "role": "output"},  # whitespace only
        "not even a dict",
    ])
    assert [item["name"] for item in kept] == ["route code table"]


def test_every_surviving_product_is_safe_for_the_call_sites_that_index_name():
    # apply_proposal:  f"{AI_BASE}/{_slug(product['name'])}"
    # revert_proposal: [p["name"] for p in proposal["newProducts"]]
    for product in _usable_products([{"name": "Route Codes"}, {"role": "input"}]):
        assert _slug(product["name"])


def test_an_all_nameless_batch_yields_an_empty_list_not_a_crash():
    assert _usable_products([{"role": "input"}, {}]) == []
    assert _usable_products(None) == []
    assert _usable_products([]) == []
