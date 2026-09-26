/* ==========================================================================
   AUTH.JS - Xử lý Đăng nhập / Đăng ký / Điều hướng theo vai trò
   Dùng cho: html/login.html
   Phụ thuộc: js/config.js (biến supabaseClient) phải nhúng TRƯỚC file này
   ========================================================================== */

// ---------- 1. LẤY CÁC PHẦN TỬ TRÊN GIAO DIỆN ----------
const elTabLoginBtn = document.getElementById("tabLoginBtn");
const elTabRegisterBtn = document.getElementById("tabRegisterBtn");
const elLoginForm = document.getElementById("loginForm");
const elRegisterForm = document.getElementById("registerForm");
const elForgotStep1Form = document.getElementById("forgotStep1Form");
const elForgotStep2Form = document.getElementById("forgotStep2Form");
const elAuthMessage = document.getElementById("authMessage");
const elLoginSubmitBtn = document.getElementById("loginSubmitBtn");
const elRegisterSubmitBtn = document.getElementById("registerSubmitBtn");
const elForgotPasswordLink = document.getElementById("forgotPasswordLink");
const elBackToLoginFromForgot1 = document.getElementById("backToLoginFromForgot1");

const elAuthContact = document.getElementById("authContact");
const elAuthContactList = document.getElementById("authContactList");

let forgotEmailCache = ""; // ghi nhớ email đang xác nhận OTP giữa bước 1 -> bước 2

// ---------- 2. KHỞI CHẠY KHI VÀO TRANG ----------
bootstrapAuthPage();

async function bootstrapAuthPage() {
  // Nếu người dùng đã đăng nhập sẵn (còn phiên), tự động điều hướng luôn
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    await redirectByRole(session.user.id);
  }

  loadContactInfo();
}

// Lấy thông tin liên hệ Admin (bảng site_setting, luôn chỉ có 1 dòng id=1)
async function loadContactInfo() {
  const { data, error } = await supabaseClient
    .from("site_setting")
    .select("phone, email, facebook")
    .eq("id", 1)
    .single();

  if (error || !data) return; // im lặng bỏ qua, không cản trở việc đăng nhập

  let html = "";
  if (data.phone) {
    html += `<a href="tel:${escapeAttr(data.phone)}">📞 ${escapeAttr(data.phone)}</a>`;
  }
  if (data.email) {
    html += `<a href="mailto:${escapeAttr(data.email)}">✉️ ${escapeAttr(data.email)}</a>`;
  }
  if (data.facebook) {
    html += `<a href="${escapeAttr(data.facebook)}" target="_blank" rel="noopener">💬 Facebook</a>`;
  }

  if (html) {
    elAuthContactList.innerHTML = html;
    elAuthContact.hidden = false;
  }
}

// ---------- 3. GẮN SỰ KIỆN ----------
elTabLoginBtn.addEventListener("click", () => showAuthView("login"));
elTabRegisterBtn.addEventListener("click", () => showAuthView("register"));
elLoginForm.addEventListener("submit", handleLogin);
elRegisterForm.addEventListener("submit", handleRegister);
elForgotPasswordLink.addEventListener("click", () => showAuthView("forgot1"));
elBackToLoginFromForgot1.addEventListener("click", () => showAuthView("login"));
elForgotStep1Form.addEventListener("submit", handleForgotStep1);
elForgotStep2Form.addEventListener("submit", handleForgotStep2);

// ---------- 4. CHUYỂN GIỮA CÁC MÀN: Đăng nhập / Đăng ký / Quên mật khẩu (2 bước) ----------
function showAuthView(view) {
  elTabLoginBtn.classList.toggle("active", view === "login");
  elTabRegisterBtn.classList.toggle("active", view === "register");
  elLoginForm.classList.toggle("active", view === "login");
  elRegisterForm.classList.toggle("active", view === "register");
  elForgotStep1Form.classList.toggle("active", view === "forgot1");
  elForgotStep2Form.classList.toggle("active", view === "forgot2");
  hideMessage();
}

// ---------- 5. XỬ LÝ ĐĂNG NHẬP ----------
async function handleLogin(event) {
  event.preventDefault();
  hideMessage();
  setLoading(elLoginSubmitBtn, true, "Đang đăng nhập...");

  const rawInput = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;

  try {
    // Nếu người dùng gõ không có "@" -> hiểu là Username, cần tra ra email thật trước
    let email = rawInput;
    if (!rawInput.includes("@")) {
      const { data: foundEmail, error: lookupError } = await supabaseClient.rpc(
        "get_email_by_username",
        { input_username: rawInput }
      );

      if (lookupError || !foundEmail) {
        showMessage("Không tìm thấy tài khoản với tên đăng nhập này.", "error");
        return;
      }
      email = foundEmail;
    }

    const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) throw authError;

    // Kiểm tra hồ sơ trong bảng "user": status có được duyệt chưa, is_admin
    const { data: profile, error: profileError } = await supabaseClient
      .from("user")
      .select("status, is_admin")
      .eq("id", authData.user.id)
      .single();

    if (profileError) throw profileError;

    if (!profile.status) {
      // Tài khoản chưa được Admin duyệt -> không cho vào, đăng xuất lại luôn
      await supabaseClient.auth.signOut();
      showMessage("Tài khoản của bạn chưa được Admin duyệt. Vui lòng chờ hoặc liên hệ quản trị viên.", "error");
      return;
    }

    // Cập nhật thời gian đăng nhập gần nhất
    await supabaseClient
      .from("user")
      .update({ last_sign_in_at: new Date().toISOString() })
      .eq("id", authData.user.id);

    showMessage("Đăng nhập thành công, đang chuyển hướng...", "success");
    window.location.href = profile.is_admin ? "./html/admin.html" : "./html/user.html";
  } catch (error) {
    showMessage(translateAuthError(error), "error");
  } finally {
    setLoading(elLoginSubmitBtn, false, "Đăng nhập");
  }
}

// ---------- 6. XỬ LÝ ĐĂNG KÝ (qua Edge Function, tự động xác nhận email luôn) ----------
async function handleRegister(event) {
  event.preventDefault();
  hideMessage();
  setLoading(elRegisterSubmitBtn, true, "Đang tạo tài khoản...");

  const userName = document.getElementById("registerName").value.trim();
  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;

  try {
    const { data, error } = await supabaseClient.functions.invoke("register-user", {
      body: { email, password, userName },
    });

    if (error) throw error;
    if (data?.error) throw new Error(data.error);

    showMessage(
      "Tạo tài khoản thành công! Tài khoản cần Admin duyệt trước khi đăng nhập được.",
      "success"
    );
    elRegisterForm.reset();
    setTimeout(() => showAuthView("login"), 1800);
  } catch (error) {
    showMessage(translateAuthError(error), "error");
  } finally {
    setLoading(elRegisterSubmitBtn, false, "Tạo tài khoản");
  }
}

// ---------- 6b. XỬ LÝ QUÊN MẬT KHẨU - BƯỚC 1: xác nhận username+email khớp, gửi mã OTP ----------
async function handleForgotStep1(event) {
  event.preventDefault();
  hideMessage();
  const submitBtn = document.getElementById("forgotStep1Btn");
  setLoading(submitBtn, true, "Đang gửi mã...");

  const userName = document.getElementById("forgotUserName").value.trim();
  const email = document.getElementById("forgotEmail").value.trim();

  try {
    const { data, error } = await supabaseClient.functions.invoke("verify-username-email", {
      body: { userName, email },
    });
    if (error) throw error;
    if (!data?.valid) throw new Error("Tên đăng nhập và email không khớp với bất kỳ tài khoản nào.");

    // Nhờ Supabase Auth gửi mã OTP qua email (không tạo tài khoản mới nếu chưa tồn tại)
    const { error: otpError } = await supabaseClient.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    if (otpError) throw otpError;

    forgotEmailCache = email;
    showMessage("Đã gửi mã xác nhận tới email của bạn. Mã có hiệu lực trong 5 phút.", "success");
    showAuthView("forgot2");
  } catch (error) {
    showMessage(error.message || "Có lỗi xảy ra, vui lòng thử lại.", "error");
  } finally {
    setLoading(submitBtn, false, "Gửi mã xác nhận");
  }
}

// ---------- 6c. XỬ LÝ QUÊN MẬT KHẨU - BƯỚC 2: xác nhận mã OTP + đặt mật khẩu mới ----------
async function handleForgotStep2(event) {
  event.preventDefault();
  hideMessage();
  const submitBtn = document.getElementById("forgotStep2Btn");
  setLoading(submitBtn, true, "Đang xác nhận...");

  const otp = document.getElementById("forgotOtp").value.trim();
  const newPassword = document.getElementById("forgotNewPassword").value;
  const confirmPassword = document.getElementById("forgotConfirmPassword").value;

  try {
    if (newPassword !== confirmPassword) throw new Error("Mật khẩu nhập lại không khớp.");
    if (newPassword.length < 6) throw new Error("Mật khẩu cần tối thiểu 6 ký tự.");
    if (!forgotEmailCache) throw new Error("Phiên xác nhận đã hết hạn, vui lòng bắt đầu lại.");

    // Xác nhận mã OTP - nếu đúng và còn hạn (5 phút), Supabase tự đăng nhập luôn (tạo session)
    const { data, error } = await supabaseClient.auth.verifyOtp({
      email: forgotEmailCache,
      token: otp,
      type: "email",
    });
    if (error) throw new Error("Mã xác nhận không đúng hoặc đã hết hạn.");

    // Đã có session hợp lệ -> đặt mật khẩu mới ngay
    const { error: updateError } = await supabaseClient.auth.updateUser({ password: newPassword });
    if (updateError) throw updateError;

    showMessage("Đặt lại mật khẩu thành công! Đang chuyển hướng...", "success");
    await redirectByRole(data.user.id);
  } catch (error) {
    showMessage(error.message || "Có lỗi xảy ra, vui lòng thử lại.", "error");
  } finally {
    setLoading(submitBtn, false, "Đặt lại mật khẩu");
  }
}

// ---------- 7. ĐIỀU HƯỚNG THEO VAI TRÒ (dùng khi đã có sẵn phiên đăng nhập) ----------
async function redirectByRole(userId) {
  const { data: profile } = await supabaseClient
    .from("user")
    .select("status, is_admin")
    .eq("id", userId)
    .single();

  if (!profile || !profile.status) return; // chưa được duyệt -> ở lại trang login

  window.location.href = profile.is_admin ? "admin.html" : "user.html";
}

// ---------- 8. HÀM TIỆN ÍCH ----------
function showMessage(text, type) {
  elAuthMessage.textContent = text;
  elAuthMessage.className = `auth-message show ${type}`;
}

function hideMessage() {
  elAuthMessage.className = "auth-message";
}

function setLoading(button, isLoading, label) {
  button.disabled = isLoading;
  button.textContent = label;
}

// Thoát ký tự đặc biệt khi chèn dữ liệu từ DB vào thuộc tính HTML (tránh lỗi/injection)
function escapeAttr(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char];
  });
}

// Dịch một số lỗi phổ biến của Supabase Auth sang tiếng Việt cho dễ hiểu
function translateAuthError(error) {
  const msg = error?.message || "";

  if (msg.includes("Invalid login credentials")) return "Sai email hoặc mật khẩu.";
  if (msg.includes("User already registered")) return "Email này đã được đăng ký trước đó.";
  if (msg.includes("Password should be at least")) return "Mật khẩu cần tối thiểu 6 ký tự.";
  if (msg.includes("Unable to validate email address")) return "Email không hợp lệ.";

  return msg || "Có lỗi xảy ra, vui lòng thử lại.";
}

// ---------- 9. TỰ ĐỘNG GẮN NÚT "HIỆN/ẨN MẬT KHẨU" VÀO MỌI Ô PASSWORD TRÊN TRANG ----------
function enablePasswordToggles() {
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    if (input.dataset.toggleAttached) return;
    input.dataset.toggleAttached = "true";

    const wrapper = document.createElement("div");
    wrapper.className = "password-field-wrap";
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "password-toggle-btn";
    toggleBtn.textContent = "👁";
    toggleBtn.setAttribute("aria-label", "Hiện/ẩn mật khẩu");
    wrapper.appendChild(toggleBtn);

    toggleBtn.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggleBtn.textContent = showing ? "👁" : "🙈";
    });
  });
}
enablePasswordToggles();