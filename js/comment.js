/* ==========================================================================
   COMMENT.JS - Module Thảo luận chung, dùng lại được cho cả user.html và admin.html
   Cách dùng: gọi CommentModule.init("commentRoot") sau khi biết currentUser
   Phụ thuộc: js/config.js (biến supabaseClient) phải nhúng TRƯỚC file này
   ========================================================================== */

const CommentModule = (() => {
  let containerEl = null;
  let currentUserId = null;
  let currentIsAdmin = false;
  let allComments = []; // danh sách phẳng, tự dựng lại thành cây cha-con khi render

  // ---------- 1. KHỞI TẠO ----------
  async function init(containerId, { userId, isAdmin }) {
    containerEl = document.getElementById(containerId);
    currentUserId = userId;
    currentIsAdmin = isAdmin;

    renderShell();
    await loadComments();
  }

  // Vẽ khung tĩnh (form viết bình luận + chỗ chứa danh sách) 1 lần duy nhất
  function renderShell() {
    containerEl.innerHTML = /* html */ `
      <section class="card">
        <form class="comment-form" id="rootCommentForm">
          <textarea class="form-control" id="rootCommentInput" placeholder="Viết bình luận..." required></textarea>
          <button type="submit" class="button button-primary">Gửi</button>
        </form>
        <div class="comment-list" id="commentListEl"></div>
        <div class="empty-state" id="commentEmptyState" hidden>
          <div>💬</div>
          <h3>Chưa có bình luận nào</h3>
          <p>Hãy là người đầu tiên bắt đầu thảo luận.</p>
        </div>
      </section>`;

    document.getElementById("rootCommentForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("rootCommentInput");
      const content = input.value.trim();
      if (!content) return;

      await postComment(content, null);
      input.value = "";
    });

    // Ủy quyền sự kiện (event delegation) cho toàn bộ nút reply/xóa/gửi-reply bên trong danh sách
    containerEl.addEventListener("click", handleListClick);
    containerEl.addEventListener("submit", handleReplySubmit);
  }

  // ---------- 2. TẢI DỮ LIỆU ----------
  async function loadComments() {
    const { data, error } = await supabaseClient
      .from("comment")
      .select("id, created_at, content, id_user, parent_id, user:id_user(user_name)")
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Lỗi tải bình luận:", error.message);
      return;
    }

    allComments = data || [];
    renderList();
  }

  // ---------- 3. VẼ DANH SÁCH (dựng cây cha - con từ danh sách phẳng) ----------
  function renderList() {
    const listEl = document.getElementById("commentListEl");
    const emptyEl = document.getElementById("commentEmptyState");

    const roots = allComments.filter((c) => !c.parent_id);
    emptyEl.hidden = roots.length > 0;

    listEl.innerHTML = roots.map((root) => renderCommentItem(root)).join("");
  }

  function renderCommentItem(comment) {
    const replies = allComments.filter((c) => c.parent_id === comment.id);
    const isOwner = comment.id_user === currentUserId;
    const withinWindow = isWithinEditWindow(comment.created_at);
    const hasReplies = allComments.some((c) => c.parent_id === comment.id);

    const canEdit = isOwner && withinWindow;
    const canDelete = currentIsAdmin || (isOwner && withinWindow && !hasReplies);
    const userName = comment.user?.user_name || "Người dùng ẩn danh";

    // Giới hạn 3 tầng: nếu comment này đã ở tầng 3 (sâu nhất), trả lời nó sẽ gắn
    // vào CÙNG tầng 3 (dùng chung cha của nó), không tạo thêm tầng 4
    const depth = getDepth(comment);
    const effectiveParentId = depth >= 3 ? comment.parent_id : comment.id;

    return /* html */ `
      <article class="comment-item" data-comment-id="${comment.id}">
        <div class="avatar">${getInitials(userName)}</div>
        <div class="comment-body">
          <div class="comment-meta">
            <strong>${escapeHTML(userName)}</strong>
            <span>${formatTimeAgo(comment.created_at)}</span>
          </div>
          <p class="comment-text" id="commentText-${comment.id}">${escapeHTML(comment.content)}</p>
          <div class="comment-actions">
            <button type="button" data-reply-toggle="${comment.id}">Trả lời</button>
            ${canEdit ? `<button type="button" data-edit-comment="${comment.id}">Sửa</button>` : ""}
            ${canDelete ? `<button type="button" class="danger" data-delete-comment="${comment.id}">Xóa</button>` : ""}
          </div>

          <form class="reply-form" id="replyForm-${comment.id}" data-parent-id="${effectiveParentId}">
            <textarea class="form-control" placeholder="Viết trả lời..." required></textarea>
            <button type="submit" class="button button-primary">Gửi</button>
          </form>

          ${replies.length ? `<div class="reply-list">${replies.map((r) => renderCommentItem(r)).join("")}</div>` : ""}
        </div>
      </article>`;
  }

  // Đếm số tầng của 1 comment (gốc = tầng 1)
  function getDepth(comment) {
    let depth = 1;
    let current = comment;
    while (current.parent_id) {
      const parent = allComments.find((c) => c.id === current.parent_id);
      if (!parent) break;
      depth += 1;
      current = parent;
    }
    return depth;
  }

  // Còn trong 15 phút kể từ lúc đăng không
  function isWithinEditWindow(createdAt) {
    return Date.now() - new Date(createdAt).getTime() < 15 * 60 * 1000;
  }

  // ---------- 4. XỬ LÝ SỰ KIỆN ----------
  function handleListClick(event) {
    const replyBtn = event.target.closest("[data-reply-toggle]");
    if (replyBtn) {
      const form = document.getElementById(`replyForm-${replyBtn.dataset.replyToggle}`);
      form.classList.toggle("open");
      if (form.classList.contains("open")) form.querySelector("textarea").focus();
      return;
    }

    const deleteBtn = event.target.closest("[data-delete-comment]");
    if (deleteBtn) {
      deleteComment(deleteBtn.dataset.deleteComment);
      return;
    }

    const editBtn = event.target.closest("[data-edit-comment]");
    if (editBtn) {
      editComment(editBtn.dataset.editComment);
    }
  }

  async function handleReplySubmit(event) {
    if (!event.target.classList.contains("reply-form")) return;
    event.preventDefault();

    const parentId = event.target.dataset.parentId;
    const textarea = event.target.querySelector("textarea");
    const content = textarea.value.trim();
    if (!content) return;

    await postComment(content, parentId);
  }

  // ---------- 5. GHI / XÓA DỮ LIỆU ----------
  async function postComment(content, parentId) {
    const { error } = await supabaseClient.from("comment").insert({
      content,
      id_user: currentUserId,
      parent_id: parentId,
    });

    if (error) {
      alert("Không gửi được bình luận: " + error.message);
      return;
    }

    await loadComments();
  }

  async function editComment(id) {
    const comment = allComments.find((c) => c.id === id);
    if (!comment) return;

    const newContent = prompt("Sửa bình luận:", comment.content);
    if (!newContent || newContent.trim() === "" || newContent === comment.content) return;

    const { error } = await supabaseClient.from("comment").update({ content: newContent.trim() }).eq("id", id);

    if (error) {
      alert("Không sửa được bình luận: " + error.message);
      return;
    }

    await loadComments();
  }

  async function deleteComment(id) {
    if (!confirm("Xóa bình luận này? (Chỉ xóa được trong 15 phút đầu và khi chưa có ai trả lời)")) return;

    const { error } = await supabaseClient.from("comment").delete().eq("id", id);

    if (error) {
      alert("Không xóa được bình luận: " + error.message);
      return;
    }

    await loadComments();
  }

  // ---------- 6. HÀM TIỆN ÍCH ----------
  function getInitials(name = "") {
    return name.trim().slice(0, 2).toUpperCase() || "??";
  }

  function formatTimeAgo(isoString) {
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 60) return "Vừa xong";
    if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`;
    return new Date(isoString).toLocaleDateString("vi-VN");
  }

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>'"]/g, (char) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char];
    });
  }

  // Chỉ để lộ ra bên ngoài hàm init() -> giữ code sạch, tránh xung đột biến toàn cục
  return { init };
})();