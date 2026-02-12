// ============ GLOBAL STATE ============
let authToken = null;
let currentUser = null;
let apiKey = '';
let currentMode = 'voice';
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let conversationHistory = [];
let sessionStartTime = null;
let durationInterval =null;
let questionCount = 0;
let correctionCount = 0;
let recognition = null;
let mediaStream = null;

// Learning session state
let learningSessionId = null;
let isLearningRecording = false;
let learningMediaRecorder = null;
let learningAudioChunks = [];

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Load stored API key if any
    apiKey = localStorage.getItem('apiKey') || '';

    checkAuth();
    initializeEventListeners();
    initializeSpeechRecognition();
});

// ============ AUTHENTICATION ============

function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(`${tab}Form`).classList.add('active');
}

async function checkAuth() {
    const token = localStorage.getItem('authToken');
    if (token) {
        try {
            const response = await fetch('/api/auth/verify', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (response.ok) {
                const data = await response.json();
                authToken = token;
                currentUser = data;
                loadDashboard();
                return;
            }
        } catch (e) {
            console.error('Auth verification failed:', e);
        }
    }
    
    showScreen('authScreen');
}

async function handleLogin() {
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    
    if (!username || !password) {
        showToast('Please fill in all fields', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            showToast(data.error || 'Login failed', 'error');
            return;
        }
        
        authToken = data.token;
        currentUser = {
            user_id: data.user_id,
            username: data.username,
            user_type: data.user_type
        };
        
        localStorage.setItem('authToken', authToken);
        loadDashboard();
        showToast('Logged in successfully!', 'success');
    } catch (e) {
        showToast('Login error: ' + e.message, 'error');
    }
}

async function handleRegister() {
    const username = document.getElementById('regUsername').value;
    const email = document.getElementById('regEmail').value;
    const password = document.getElementById('regPassword').value;
    const userType = document.getElementById('regUserType').value;
    
    if (!username || !email || !password) {
        showToast('Please fill in all fields', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password, user_type: userType })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            showToast(data.error || 'Registration failed', 'error');
            return;
        }
        
        showToast('Registration successful! Please login.', 'success');
        switchAuthTab('login');
    } catch (e) {
        showToast('Registration error: ' + e.message, 'error');
    }
}

async function handleLogout() {
    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
    } catch (e) {
        console.error('Logout error:', e);
    }
    
    localStorage.removeItem('authToken');
    authToken = null;
    currentUser = null;
    checkAuth();
    showToast('Logged out successfully', 'success');
}

// ============ DASHBOARD MANAGEMENT ============

function loadDashboard() {
    showScreen(currentUser.user_type === 'teacher' ? 'teacherDashboard' : 'studentDashboard');
    
    if (currentUser.user_type === 'student') {
        document.getElementById('userData').textContent = `👤 ${currentUser.username}`;
        loadAssignments();
        // populate dashboard API key input if present
        const dashInput = document.getElementById('dashboardApiKeyInput');
        if (dashInput) dashInput.value = apiKey || localStorage.getItem('apiKey') || '';
    } else {
        document.getElementById('teacherData').textContent = `👤 ${currentUser.username}`;
        loadTeacherPapers();
        const tInput = document.getElementById('teacherDashboardApiKeyInput');
        if (tInput) tInput.value = apiKey || localStorage.getItem('apiKey') || '';
    }
}

function saveDashboardApiKey(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const key = input.value.trim();
    if (!key) {
        showToast('API key cannot be empty', 'error');
        return;
    }
    apiKey = key;
    localStorage.setItem('apiKey', key);
    showToast('API key saved for this browser', 'success');
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screenEl = document.getElementById(screenId);
    if (screenEl) {
        screenEl.classList.add('active');
        try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    }
}

function switchSection(sectionId) {
    document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    const sectionEl = document.getElementById(sectionId);
    if (sectionEl) sectionEl.classList.add('active');

    const sectionName = sectionId.replace(/Section$/, '');
    const navBtn = document.querySelector(`[data-section="${sectionName}"]`);
    if (navBtn) navBtn.classList.add('active');
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
}

// ============ STUDENT FUNCTIONS ============

async function loadAssignments() {
    try {
        const response = await fetch('/api/student/assignments', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        const list = document.getElementById('assignmentsList');
        
        if (!data.assignments || data.assignments.length === 0) {
            list.innerHTML = '<p class="no-data">No assignments yet</p>';
            return;
        }
        
        list.innerHTML = data.assignments.map(assign => `
            <div class="assignment-card">
                <div class="assignment-header">
                    <h3>${assign.title}</h3>
                    <span class="difficulty-badge ${assign.difficulty}">${assign.difficulty}</span>
                </div>
                <p class="assignment-description">${assign.description || 'No description'}</p>
                <p class="assignment-teacher">By: ${assign.teacher_name}</p>
                <div class="assignment-deadline">
                    <small>Deadline: ${new Date(assign.deadline).toLocaleDateString() || 'No deadline'}</small>
                </div>
                <div class="assignment-status">
                    <span class="status-badge ${assign.status}">${assign.status}</span>
                </div>
                <button class="primary-btn" onclick="startSubmission('${assign.id}', ${JSON.stringify(assign.questions).replace(/"/g, '&quot;')})">
                    ${assign.status === 'pending' ? 'Start Submission' : 'View'}
                </button>
            </div>
        `).join('');
    } catch (e) {
        showToast('Error loading assignments: ' + e.message, 'error');
    }
}

async function loadSubmissions() {
    try {
        const response = await fetch('/api/student/submissions', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        const list = document.getElementById('submissionsList');
        
        if (!data.submissions || data.submissions.length === 0) {
            list.innerHTML = '<p class="no-data">No submissions yet</p>';
            return;
        }
        
        list.innerHTML = data.submissions.map(sub => `
            <div class="submission-item">
                <div class="submission-info">
                    <h4>${sub.title}</h4>
                    <p>Submitted: ${new Date(sub.submitted_at).toLocaleString()}</p>
                    ${sub.graded ? `<p class="grade-info">Grade: <strong>${sub.grade}</strong></p>` : '<p class="pending">Pending review</p>'}
                </div>
                ${sub.graded && sub.feedback ? `<button class="secondary-btn" onclick="viewFeedback('${sub.id}')">View Feedback</button>` : ''}
            </div>
        `).join('');
    } catch (e) {
        showToast('Error loading submissions: ' + e.message, 'error');
    }
}

function startSubmission(assignmentId, questions) {
    // Open submission modal and load paper content
    const modal = document.getElementById('submissionModal');
    const contentDiv = document.getElementById('modalPaperContent');
    const titleEl = document.getElementById('modalPaperTitle');
    const assignInput = document.getElementById('modalAssignmentId');

    assignInput.value = assignmentId;
    contentDiv.innerHTML = 'Loading...';
    titleEl.textContent = 'Question Paper';
    modal.style.display = 'flex';

    // Fetch paper by assignment
    fetch(`/api/student/paper-by-assignment/${assignmentId}`, {
        headers: { 'Authorization': `Bearer ${authToken}` }
    }).then(r => r.json()).then(data => {
        if (!data || !data.success) {
            contentDiv.textContent = data.error || 'Failed to load paper';
            return;
        }
        const paper = data.paper;
        titleEl.textContent = paper.title || 'Question Paper';
        let html = '';
        if (paper.questions && Array.isArray(paper.questions)) {
            paper.questions.forEach((q, i) => {
                const text = (q.text || q).toString();
                html += `<div style="margin-bottom:10px;"><strong>Q${i+1}.</strong> ${escapeHtml(text)}</div>`;
            });
        } else {
            html = `<pre>${escapeHtml(JSON.stringify(paper.questions || paper, null, 2))}</pre>`;
        }
        contentDiv.innerHTML = html;
    }).catch(e => {
        contentDiv.textContent = 'Error loading paper';
    });
}

// Modal controls
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('submissionModal');
    const closeBtn = document.getElementById('closeSubmissionModal');
    if (closeBtn) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });

    const downloadBtn = document.getElementById('downloadPaperBtn');
    if (downloadBtn) downloadBtn.addEventListener('click', async () => {
        const assignmentId = document.getElementById('modalAssignmentId').value;
        if (!assignmentId) return showToast('No assignment selected', 'error');
        try {
            const resp = await fetch(`/api/student/download-paper/${assignmentId}`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            if (!resp.ok) {
                const err = await resp.json().catch(()=>({error:'Download failed'}));
                return showToast(err.error || 'Download failed', 'error');
            }
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `paper_${assignmentId}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            showToast('Download error: ' + e.message, 'error');
        }
    });

    const pdfForm = document.getElementById('pdfSubmitForm');
    if (pdfForm) pdfForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const assignmentId = document.getElementById('modalAssignmentId').value;
        const fileInput = document.getElementById('submissionFileInput');
        if (!fileInput.files || fileInput.files.length === 0) return showToast('Select a PDF to submit', 'error');

        const fd = new FormData();
        fd.append('assignment_id', assignmentId);
        fd.append('submission', fileInput.files[0]);
        // Include API key (if user saved one in dashboard) so server can auto-grade
        if (apiKey) fd.append('api_key', apiKey);

        try {
            const resp = await fetch('/api/student/submit-pdf', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}` },
                body: fd
            });
            const data = await resp.json();
            if (!resp.ok) return showToast(data.error || 'Upload failed', 'error');
            showToast('PDF submitted successfully', 'success');
            modal.style.display = 'none';
            // refresh assignments/submissions
            loadAssignments();
            loadSubmissions();
        } catch (err) {
            showToast('Submission error: ' + err.message, 'error');
        }
    });
});

function viewFeedback(submissionId) {
    // Implementation for showing feedback details
    showToast('Feedback viewer coming soon', 'info');
}

// ============ INTERVIEW TRAINING ============

function initializeEventListeners() {
    // Auth
    document.getElementById('loginBtn').addEventListener('click', handleLogin);
    document.getElementById('registerBtn').addEventListener('click', handleRegister);
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    document.getElementById('teacherLogoutBtn').addEventListener('click', handleLogout);
    
    // Navigation (scoped to each dashboard) - prevents cross-dashboard actions
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const section = e.currentTarget.dataset.section;
            const dashboard = e.currentTarget.closest('.dashboard-container');
            if (!dashboard) return;

            // Deactivate only within this dashboard
            dashboard.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
            dashboard.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

            const sectionId = section + 'Section';
            const sectionEl = dashboard.querySelector('#' + sectionId);
            if (sectionEl) sectionEl.classList.add('active');

            const navBtn = dashboard.querySelector(`[data-section="${section}"]`);
            if (navBtn) navBtn.classList.add('active');

            // Load data for specific sections (scoped)
            // Student dashboard
            if (dashboard.querySelector('#assignmentsList') && section === 'assignments') loadAssignments();
            if (dashboard.querySelector('#submissionsList') && section === 'submissions') loadSubmissions();
            if (dashboard.querySelector('#interviewContainer') && section === 'interview') setupInterview();
            if (dashboard.querySelector('#learningContainer') && section === 'learning') setupLearning();

            // Teacher dashboard
            if (dashboard.querySelector('#papersList') && section === 'papers') loadTeacherPapers();
            if (dashboard.querySelector('#submissionsTable') && section === 'submissions') {
                // clear selection
                const sel = dashboard.querySelector('#paperSelect'); if (sel) sel.value = '';
            }
        });
    });
    
    // Interview controls
    document.getElementById('recordBtn').addEventListener('click', toggleRecording);
    document.getElementById('sendBtn').addEventListener('click', sendChatMessage);
    document.getElementById('startInterviewBtn').addEventListener('click', startInterview);
    document.getElementById('newInterviewBtn').addEventListener('click', startNewInterview);
    
    // Learning controls
    document.getElementById('startLearningBtn').addEventListener('click', startLearningSession);
    document.getElementById('learningMicBtn').addEventListener('click', toggleLearningRecording);
    
    // API setup controls
    document.getElementById('startBtn').addEventListener('click', handleStartSession);
    document.getElementById('backBtn').addEventListener('click', () => loadDashboard());
    document.getElementById('toggleApiKey').addEventListener('click', toggleApiKeyVisibility);
    // Assignment form and teacher upload/generate handlers
    const assignmentForm = document.getElementById('assignmentForm');
    if (assignmentForm) assignmentForm.addEventListener('submit', handleCreateAssignment);
    const uploadBtn = document.getElementById('uploadSessionBtn');
    if (uploadBtn) uploadBtn.addEventListener('click', uploadTeacherSession);
    const genBtn = document.getElementById('generatePaperBtn');
    if (genBtn) genBtn.addEventListener('click', generatePaperFromSession);
    // Dashboard API key save buttons (student + teacher)
    const dashSave = document.getElementById('dashboardSaveApiBtn');
    if (dashSave) dashSave.addEventListener('click', () => saveDashboardApiKey('dashboardApiKeyInput'));
    const teacherDashSave = document.getElementById('teacherDashboardSaveApiBtn');
    if (teacherDashSave) teacherDashSave.addEventListener('click', () => saveDashboardApiKey('teacherDashboardApiKeyInput'));
    
    // Chat input
    document.getElementById('chatInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
}

// ============ TEACHER UPLOAD / GENERATION ============
async function uploadTeacherSession() {
    const syllabusFile = document.getElementById('syllabusFile').files[0];
    const pyqFile = document.getElementById('pyqFile').files[0];

    if (!syllabusFile && !pyqFile) {
        showToast('Please choose at least one PDF to upload', 'error');
        return;
    }

    const formData = new FormData();
    if (syllabusFile) formData.append('syllabus', syllabusFile);
    if (pyqFile) formData.append('pyq', pyqFile);

    try {
        const resp = await fetch('/api/teacher/session/create', {
            method: 'POST',
            body: formData
        });
        const data = await resp.json();
        if (!resp.ok) {
            showToast(data.error || 'Upload failed', 'error');
            return;
        }

        // store session id locally for quick operations
        window._teacher_session_id = data.session_id;
        showToast('Files uploaded, teacher session started', 'success');
    } catch (e) {
        showToast('Upload error: ' + e.message, 'error');
    }
}

async function generatePaperFromSession() {
    const sessionId = window._teacher_session_id;
    if (!sessionId) {
        showToast('Please upload content first (Upload & Start Teacher Session)', 'error');
        return;
    }

    const numQuestions = parseInt(document.getElementById('numQuestions').value || '10', 10);
    const difficulty = document.getElementById('assignDifficulty').value || 'medium';
    const questionTypes = Array.from(document.querySelectorAll('#createSection .checkbox-group input:checked')).map(i => i.value);

    try {
        const resp = await fetch('/api/teacher/generate-paper', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, num_questions: numQuestions, difficulty, question_types: questionTypes, api_key: apiKey })
        });
        const data = await resp.json();
        if (!resp.ok) {
            showToast(data.error || 'Paper generation failed', 'error');
            return;
        }

        // Display generated paper (simple viewer)
        const list = document.getElementById('generatedPapersList');
        const id = data.paper_id;
        const content = data.content;
        const item = document.createElement('div');
        item.className = 'paper-preview';
        item.innerHTML = `<h4>Generated Paper</h4><pre style="white-space:pre-wrap;max-height:200px;overflow:auto;background:#f8f8f8;padding:8px;border-radius:6px">${escapeHtml(content)}</pre><button class="secondary-btn" onclick="useGeneratedPaper('${id}')">Use This Paper for Assignment</button>`;
        list.prepend(item);
        // keep a local map
        window._generated_papers = window._generated_papers || {};
        window._generated_papers[id] = content;
        showToast('Paper generated successfully', 'success');
    } catch (e) {
        showToast('Generation error: ' + e.message, 'error');
    }
}

function escapeHtml(unsafe) {
    return unsafe.replace(/[&<"'`=\/]/g, function (s) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#47;','`':'&#96;','=':'&#61;'})[s];
    });
}

function useGeneratedPaper(paperId) {
    const content = window._generated_papers && window._generated_papers[paperId];
    if (!content) return showToast('Paper not found', 'error');

    // Parse questions simply by splitting lines between ===QUESTION PAPER=== markers
    const parts = content.split(/===QUESTION PAPER===|===END PAPER===/i).filter(p=>p.trim());
    const questionsText = parts[0] || content;
    const questions = questionsText.split(/\n\n|\n\d+\.|\n\[/).map(q=>q.trim()).filter(q=>q.length>20).slice(0, parseInt(document.getElementById('numQuestions').value || '10',10));

    // Save parsed questions into a hidden field for assignment creation
    window._selected_generated_questions = questions.map((q,i)=>({ qid: i+1, text: q }));
    showToast('Generated paper selected — create assignment to assign it to students', 'info');
}

// ============ ASSIGNMENT CREATION ============
async function handleCreateAssignment(e) {
    e.preventDefault();
    const title = document.getElementById('assignTitle').value;
    const description = document.getElementById('assignDescription').value;
    const difficulty = document.getElementById('assignDifficulty').value;
    const deadline = document.getElementById('assignDeadline').value;
    const studentListRaw = document.getElementById('studentList').value.trim();
    const student_usernames = studentListRaw ? studentListRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];

    // Use generated questions if available, otherwise create placeholder questions
    const questions = window._selected_generated_questions || [{ qid:1, text: 'Write your answer here' }];

    try {
        const resp = await fetch('/api/teacher/create-assignment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ student_ids: student_usernames, title, description, questions, difficulty, deadline })
        });
        const data = await resp.json();
        if (!resp.ok) {
            showToast(data.error || 'Create assignment failed', 'error');
            return;
        }
        showToast('Assignment created and assigned', 'success');
        // refresh papers list
        loadTeacherPapers();
    } catch (e) {
        showToast('Error creating assignment: ' + e.message, 'error');
    }
}

function initializeSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn('Speech Recognition not supported');
        return;
    }
    
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    
    recognition.onresult = async (event) => {
        const lastResult = event.results[event.results.length - 1];
        if (lastResult.isFinal) {
            const transcript = lastResult[0].transcript;
            addTranscript('You: ' + transcript);
            await processUserResponse(transcript);
        }
    };
    
    recognition.onerror = (event) => {
        console.error('Speech error:', event.error);
        showToast('Speech recognition error', 'error');
        stopRecording();
    };
}

function toggleRecording() {
    if (isRecording) {
        stopRecording();
    } else {
        startRecording();
    }
}

function startRecording() {
    if (!recognition) {
        showToast('Speech recognition not supported', 'error');
        return;
    }
    
    isRecording = true;
    const btn = document.getElementById('recordBtn');
    btn.classList.add('recording');
    btn.querySelector('.btn-text').textContent = 'Listening...';
    
    try {
        recognition.start();
    } catch (e) {
        console.error('Error starting recording:', e);
        stopRecording();
    }
}

function stopRecording() {
    isRecording = false;
    const btn = document.getElementById('recordBtn');
    btn.classList.remove('recording');
    btn.querySelector('.btn-text').textContent = 'Press to Speak';
    
    if (recognition) {
        try {
            recognition.stop();
        } catch (e) {
            console.error('Error stopping recording:', e);
        }
    }
}

function addTranscript(text) {
    const transcript = document.getElementById('voiceTranscript');
    const entry = document.createElement('div');
    entry.style.marginBottom = '1rem';
    entry.textContent = text;
    transcript.appendChild(entry);
    transcript.scrollTop = transcript.scrollHeight;
}

function toggleApiKeyVisibility() {
    const input = document.getElementById('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
}

async function handleStartSession() {
    apiKey = document.getElementById('apiKey').value.trim();
    
    if (!apiKey) {
        showToast('Please enter your API key', 'error');
        return;
    }
    
    const isValid = await testApiKey();
    if (!isValid) {
        showToast('Invalid API key', 'error');
        return;
    }
    
    showScreen('studentDashboard');
    showToast('API key configured!', 'success');
}

async function testApiKey() {
    try {
        const response = await fetch('/api/test-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: apiKey })
        });
        return response.ok;
    } catch (e) {
        return false;
    }
}

function setupInterview() {
    // Show interview setup if not already in interview
    if (!document.getElementById('interviewContainer').style.display || 
        document.getElementById('interviewContainer').style.display === 'none') {
        // Already in setup
    }
}

function startInterview() {
    if (!apiKey) {
        showToast('Please configure API key first', 'error');
        showScreen('apiSetup');
        return;
    }
    
    document.querySelector('.interview-setup').style.display = 'none';
    document.getElementById('interviewContainer').style.display = 'block';
    
    sessionStartTime = Date.now();
    startDurationTimer();
    questionCount = 0;
    correctionCount = 0;
    conversationHistory = [];
    
    document.getElementById('voiceTranscript').innerHTML = '';
    document.getElementById('chatMessages').innerHTML = '';
    updateStats();
    
    sendInitialGreeting();
    
    // Set up mode
    const mode = document.getElementById('practiceMode').value;
    if (mode === 'voice') {
        document.getElementById('voiceMode').style.display = 'flex';
        document.getElementById('chatMode').style.display = 'none';
    } else {
        document.getElementById('voiceMode').style.display = 'none';
        document.getElementById('chatMode').style.display = 'block';
    }
}

async function sendInitialGreeting() {
    const interviewType = document.getElementById('interviewType').value;
    const difficulty = document.getElementById('difficulty').value;
    
    const prompt = `You are an expert interview coach. Start a ${interviewType} interview at ${difficulty} level.
    Greet the candidate warmly and ask your first question. Keep your responses natural and conversational.`;
    
    const response = await callGeminiAPI(prompt);
    
    if (document.getElementById('voiceMode').style.display !== 'none') {
        addTranscript('Interviewer: ' + response);
        speakText(response);
    } else {
        addChatMessage(response, 'ai');
    }
    
    questionCount++;
    updateStats();
}

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    addChatMessage(message, 'user');
    input.value = '';
    input.style.height = 'auto';
    
    processUserResponse(message);
}

function addChatMessage(text, sender) {
    const chatMessages = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `message ${sender}`;
    div.innerHTML = `<div class="message-content">${text}</div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function processUserResponse(userMessage) {
    conversationHistory.push({
        role: 'user',
        content: userMessage
    });
    
    const interviewType = document.getElementById('interviewType').value;
    const difficulty = document.getElementById('difficulty').value;
    
    const prompt = `You are an expert interview coach conducting a ${interviewType} interview at ${difficulty} level.
    
Previous conversation:
${conversationHistory.slice(-5).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

The candidate just said: "${userMessage}"

Analyze their response and:
1. If there are issues, provide a brief correction starting with "Correction: "
2. Provide encouragement if tone is good
3. Ask your next question

Keep responses natural and conversational.`;
    
    const response = await callGeminiAPI(prompt);
    
    conversationHistory.push({
        role: 'assistant',
        content: response
    });
    
    const hasCorrection = response.toLowerCase().includes('correction:');
    if (hasCorrection) correctionCount++;
    
    if (document.getElementById('voiceMode').style.display !== 'none') {
        addTranscript('Interviewer: ' + response);
        speakText(response);
    } else {
        addChatMessage(response, 'ai');
    }
    
    questionCount++;
    updateStats();
}

async function callGeminiAPI(prompt) {
    try {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: apiKey,
                prompt: prompt,
                history: conversationHistory
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            showToast('API error: ' + (data.error || 'Unknown error'), 'error');
            return 'I apologize, but I encountered an error. Could you please repeat that?';
        }
        
        return data.response;
    } catch (e) {
        showToast('API call failed: ' + e.message, 'error');
        return 'I apologize, but I encountered an error. Could you please repeat that?';
    }
}

function speakText(text) {
    if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1;
       utterance.volume = 1;
        
        window.speechSynthesis.speak(utterance);
    }
}

function startDurationTimer() {
    if (durationInterval) clearInterval(durationInterval);
    
    durationInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        document.getElementById('sessionDuration').textContent = 
            `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }, 1000);
}

function updateStats() {
    document.getElementById('questionCount').textContent = questionCount;
    document.getElementById('correctionCount').textContent = correctionCount;
}

function startNewInterview() {
    conversationHistory = [];
    questionCount = 0;
    correctionCount = 0;
    sessionStartTime = Date.now();
    updateStats();
    
    document.getElementById('chatMessages').innerHTML = '';
    document.getElementById('voiceTranscript').innerHTML = '';
    
    sendInitialGreeting();
}

// ============ INTERACTIVE LEARNING ============

function setupLearning() {
    // Setup already in HTML
}

async function startLearningSession() {
    const topic = document.getElementById('learningTopic').value;
    const content = document.getElementById('learningContent').value;
    
    if (!topic || !content) {
        showToast('Please enter topic and content', 'error');
        return;
    }
    
    if (!apiKey) {
        showToast('Please configure API key first', 'error');
        showScreen('apiSetup');
        return;
    }
    
    try {
        const response = await fetch('/api/learning/create-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                topic, content, user_id: currentUser.user_id
            })
        });
        
        const data = await response.json();
        learningSessionId = data.session_id;
        
        document.querySelector('.learning-setup').style.display = 'none';
        document.getElementById('learningContainer').style.display = 'block';
        document.getElementById('learningTopicDisplay').textContent = topic;
        document.getElementById('learningContentDisplay').textContent = content;
        
        showToast('Learning session started!', 'success');
    } catch (e) {
        showToast('Error starting session: ' + e.message, 'error');
    }
}

function toggleLearningRecording() {
    if (isLearningRecording) {
        stopLearningRecording();
    } else {
        startLearningRecording();
    }
}

async function startLearningRecording() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        learningMediaRecorder = new MediaRecorder(mediaStream);
        learningAudioChunks = [];
        isLearningRecording = true;
        
        learningMediaRecorder.ondataavailable = (e) => {
            learningAudioChunks.push(e.data);
        };
        
        learningMediaRecorder.onstop = async () => {
            const audioBlob = new Blob(learningAudioChunks, { type: 'audio/wav' });
            await saveLearningAudio(audioBlob);
        };
        
        learningMediaRecorder.start();
        
        const btn = document.getElementById('learningMicBtn');
        btn.classList.add('recording');
        btn.querySelector('span').textContent = 'Recording...';
    } catch (e) {
        showToast('Microphone access denied: ' + e.message, 'error');
    }
}

function stopLearningRecording() {
    if (!learningMediaRecorder) return;
    
    isLearningRecording = false;
    learningMediaRecorder.stop();
    
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }
    
    const btn = document.getElementById('learningMicBtn');
    btn.classList.remove('recording');
    btn.querySelector('span').textContent = 'Press to Record';
}

async function saveLearningAudio(audioBlob) {
    try {
        // Convert to base64
        const reader = new FileReader();
        reader.onload = async (e) => {
            const audioBase64 = e.target.result;
            
            // Transcribe audio if available (demonstrate concept)
            const transcript = `Audio recording saved at ${new Date().toLocaleTimeString()}`;
            
            // Add to transcript
            const transcriptDiv = document.getElementById('learningTranscript');
            const entry = document.createElement('div');
            entry.style.marginBottom = '1rem';
            entry.style.padding = '10px';
            entry.style.backgroundColor = '#f0f0f0';
            entry.style.borderRadius = '8px';
            entry.textContent = transcript;
            transcriptDiv.appendChild(entry);
            
            // Save to backend
            await fetch('/api/learning/save-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: learningSessionId,
                    audio_blob: audioBase64,
                    transcript: transcript
                })
            });
            
            showToast('Audio saved successfully!', 'success');
        };
        reader.readAsDataURL(audioBlob);
    } catch (e) {
        showToast('Error saving audio: ' + e.message, 'error');
    }
}

// ============ TEACHER FUNCTIONS ============

async function loadTeacherPapers() {
    try {
        const response = await fetch('/api/teacher/papers', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        const list = document.getElementById('papersList');
        
        if (!data.papers || data.papers.length === 0) {
            list.innerHTML = '<p class="no-data">No question papers yet</p>';
            return;
        }
        
        list.innerHTML = data.papers.map(paper => `
            <div class="paper-card">
                <div class="paper-header">
                    <h3>${paper.title}</h3>
                    <span class="difficulty-badge ${paper.difficulty}">${paper.difficulty}</span>
                </div>
                <p class="paper-description">${paper.description || ''}</p>
                <div class="paper-stats">
                    <span>Assigned: ${paper.total_assigned}</span>
                    <span>Submitted: ${paper.submitted}</span>
                    <span>Graded: ${paper.graded}</span>
                </div>
                <button class="secondary-btn" onclick="viewSubmissions('${paper.id}')">View Submissions</button>
            </div>
        `).join('');
    } catch (e) {
        showToast('Error loading papers: ' + e.message, 'error');
    }
}

function viewSubmissions(paperId) {
    switchSection('gradeSection');
    document.getElementById('paperSelect').value = paperId;
    loadSubmissionsForPaper(paperId);
}

async function loadSubmissionsForPaper(paperId) {
    try {
        const response = await fetch(`/api/teacher/submissions/${paperId}`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        
        const data = await response.json();
        const table = document.getElementById('submissionsTable');
        
        if (!data.submissions || data.submissions.length === 0) {
            table.innerHTML = '<p class="no-data">No submissions yet</p>';
            return;
        }
        
        table.innerHTML = `<div class="submissions-table-header">
            <div>Student</div>
            <div>Submitted</div>
            <div>Grade</div>
            <div>Action</div>
        </div>` + data.submissions.map(sub => `
            <div class="submission-row">
                <div>${sub.username}</div>
                <div>${new Date(sub.submitted_at).toLocaleDateString()}</div>
                <div>${sub.graded ? sub.grade : 'Pending'}</div>
                <div>
                    <button class="secondary-btn" onclick="gradeSubmission('${sub.id}')">
                        ${sub.graded ? 'Edit' : 'Grade'}
                    </button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        showToast('Error loading submissions: ' + e.message, 'error');
    }
}

function gradeSubmission(answerId) {
    const grade = prompt('Enter grade (e.g., 8/10):');
    const feedback = prompt('Enter feedback:');
    
    if (grade && feedback) {
        submitGrade(answerId, grade, feedback);
    }
}

async function submitGrade(answerId, grade, feedback) {
    try {
        const response = await fetch('/api/teacher/grade', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ answer_id: answerId, grade, feedback, api_key: apiKey })
        });
        
        if (response.ok) {
            showToast('Grade saved successfully!', 'success');
            // Reload submissions
            const paperId = document.getElementById('paperSelect').value;
            loadSubmissionsForPaper(paperId);
        }
    } catch (e) {
        showToast('Error saving grade: ' + e.message, 'error');
    }
}

// ============ UTILITIES ============

function showToast(message, type = 'info') {
    const toast = document.getElementById('statusToast');
    toast.querySelector('.toast-message').textContent = message;
    toast.className = `status-toast ${type}`;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}
