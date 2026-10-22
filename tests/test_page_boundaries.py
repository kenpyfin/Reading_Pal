from backend.services import page_boundaries as page_boundaries

def _assert_pages_cover(markdown, boundaries):
    assert boundaries
    assert boundaries[0]["start"] == 0
    assert boundaries[-1]["end"] == len(markdown)
    for current, nxt in zip(boundaries, boundaries[1:]):
        assert current["end"] == nxt["start"]
        assert current["end"] > current["start"]


def _page_screen_cost(markdown, start, end):
    chunk = markdown[start:end]
    images = list(page_boundaries._MARKDOWN_IMAGE_RE.finditer(chunk))
    body = page_boundaries._MARKDOWN_IMAGE_RE.sub("", chunk)
    text = sum(1 for char in body if not char.isspace())
    return text, len(images)


def test_reader_page_budget_is_one_third_of_the_previous_cap():
    assert page_boundaries.PAGE_SCREEN_CHARS == 1000
    assert page_boundaries.PAGE_BUDGET_CHARS == 2000


def test_page_boundary_starts_on_chapter_line():
    body = "word " * 1000
    markdown = body + "\nChapter 2\n" + ("tail " * 400)
    chapter_at = markdown.index("Chapter 2")
    boundaries = page_boundaries._calculate_page_boundaries(markdown, 6000)
    _assert_pages_cover(markdown, boundaries)
    assert any(boundary["start"] == chapter_at for boundary in boundaries)


def test_page_budget_caps_text_images_and_fences():
    long_word = "a" * 7000
    word_pages = page_boundaries._calculate_page_boundaries(long_word, 6000)
    _assert_pages_cover(long_word, word_pages)
    assert word_pages[0]["end"] == 6000

    image = "![](/images/app/a.png)"
    one_screen = ("b" * 3000) + image + ("c" * 3000)
    one_screen_pages = page_boundaries._calculate_page_boundaries(one_screen, 6000)
    _assert_pages_cover(one_screen, one_screen_pages)
    assert one_screen_pages[0]["end"] == 3000 + len(image)

    overflow = ("d" * 3001) + image
    overflow_pages = page_boundaries._calculate_page_boundaries(overflow, 6000)
    _assert_pages_cover(overflow, overflow_pages)
    assert overflow_pages[0]["end"] == 3001

    images = (
        "![](/images/app/a.png)\n\n"
        "![](/images/app/b.png)\n\n"
        "![](/images/app/c.png)"
    )
    image_pages = page_boundaries._calculate_page_boundaries(images, 6000)
    _assert_pages_cover(images, image_pages)
    third_at = images.index("![](/images/app/c.png)")
    first_page = images[: image_pages[0]["end"]]
    assert "a.png" in first_page and "b.png" in first_page
    assert "c.png" not in first_page and image_pages[0]["end"] <= third_at

    fenced = ("e" * 5900) + "\n```\n" + ("code " * 100) + "\n```\n"
    fence_at = fenced.index("```")
    fence_pages = page_boundaries._calculate_page_boundaries(fenced, 6000)
    _assert_pages_cover(fenced, fence_pages)
    assert fence_pages[0]["end"] <= fence_at
    assert fence_pages[0]["end"] <= 6000

    past_heading = ("word " * 1300) + "\nChapter 9\n"
    past_pages = page_boundaries._calculate_page_boundaries(past_heading, 6000)
    _assert_pages_cover(past_heading, past_pages)
    assert past_pages[0]["end"] <= 6000
    chapter_at = past_heading.index("Chapter 9")
    assert chapter_at > 6000
    assert all(boundary["start"] != chapter_at for boundary in past_pages)

    for sample in (long_word, one_screen, overflow, images, fenced, past_heading):
        for boundary in page_boundaries._calculate_page_boundaries(sample, 6000):
            text, image_count = _page_screen_cost(sample, boundary["start"], boundary["end"])
            assert image_count <= 2
            assert text + (image_count * 3000) <= 6000


