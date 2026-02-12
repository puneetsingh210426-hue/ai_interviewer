// Global state
let apiKey = '';
let currentMode = 'voice';
let appMode = 'interviewer'; // 'interviewer' or 'teacher'
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let conversationHistory = [];
let sessionStartTime = null;
let durationInterval = null;
let questionCount = 0;
let correctionCount = 0;
let recognition = null;
let audioContext = null;
let mediaStream = null;
let currentAudioBlob = null;

// Teacher mode state
let teacherSessionId = null;
let currentTeacherMode = 'teach';

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    initializeSpeechRecognition();
});

function initializeEventListeners() {
    // API Setup
    document.getElementById('toggleApiKey').addEventListener('click', toggleApiKeyVisibility);
    document.getElementById('startBtn').addEventListener('click', handleStartSession);
    
    // Mode choice
    document.getElementById('interviewerModeBtn').addEventListener('click', () => selectAppMode('interviewer'));
    document.getElementById('teacherModeBtn').addEventListener('click', () => selectAppMode('teacher'));
    
    // Teacher Setup
    document.getElementById('startTeachingBtn').addEventListener('click', startTeachingSession);
    document.getElementById('backToModeBtn').addEventListener('click', backToModeSelection);
    document.getElementById('syllabusFile').addEventListener('change', (e) => {
        const info = document.getElementById('syllabusInfo');
        if (e.target.files.length > 0) {
            info.textContent = '✓ ' + e.target.files[0].name + ' selected';
        }
    });
    document.getElementById('pyqFile').addEventListener('change', (e) => {
        const info = document.getElementById('pyqInfo');
        if (e.target.files.length > 0) {
            info.textContent = '✓ ' + e.target.files[0].name + ' selected';
        }
    });
    
    // Mode switching (Interview)
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => switchMode(e.target.dataset.mode || e.target.closest('.mode-btn').dataset.mode));
    });
    
    // Teacher mode switching
    document.querySelectorAll('.teacher-mode-btn').forEach(btn => {
        btn.addEventListener('click', (e) => switchTeacherMode(e.target.dataset.teacherMode || e.target.closest('.teacher-mode-btn').dataset.teacherMode));
    });
    
    // Voice controls
    document.getElementById('recordBtn').addEventListener('click', toggleRecording);
    
    // Chat controls
    document.getElementById('sendBtn').addEventListener('click', sendChatMessage);
    document.getElementById('chatInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });
    
    // Auto-resize textarea
    document.getElementById('chatInput').addEventListener('input', (e) => {
        e.target.style.height = 'auto';
        e.target.style.height = e.target.scrollHeight + 'px';
    });
    
    // New interview
    document.getElementById('newInterviewBtn').addEventListener('click', startNewInterview);
    
    // Teacher mode controls
    document.getElementById('teachSendBtn').addEventListener('click', sendTeachQuestion);
    document.getElementById('teachInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendTeachQuestion();
        }
    });
    
    document.getElementById('generatePaperBtn').addEventListener('click', generateQuestionPaper);
    document.getElementById('gradeAnswerBtn').addEventListener('click', submitForGrading);
    document.getElementById('newTeachingSessionBtn').addEventListener('click', startNewTeachingSession);
}

function toggleApiKeyVisibility() {
    const input = document.getElementById('apiKey');
    const type = input.type === 'password' ? 'text' : 'password';
    input.type = type;
}

async function handleStartSession() {
    const apiKeyInput = document.getElementById('apiKey');
    apiKey = apiKeyInput.value.trim();
    
    if (!apiKey) {
        showToast('Please enter your Gemini API key', 'error');
        return;
    }
    
    // Test API key
    const isValid = await testApiKey();
    if (!isValid) {
        showToast('Invalid API key. Please check and try again.', 'error');
        return;
    }
    
    if (appMode === 'teacher') {
        // Go to teacher setup
        document.getElementById('apiSetup').classList.remove('active');
        document.getElementById('teacherSetup').classList.add('active');
    } else {
        // Start interview
        document.getElementById('apiSetup').classList.remove('active');
        document.getElementById('mainScreen').classList.add('active');
        
        // Start session
        sessionStartTime = Date.now();
        startDurationTimer();
        
        // Initial greeting
        await sendInitialGreeting();
        
        showToast('Interview session started!', 'success');
    }
}

async function testApiKey() {
    try {
        const response = await fetch('/api/test-key', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                api_key: apiKey
            })
        });
        
        const data = await response.json();
        return data.valid === true;
    } catch (error) {
        console.error('API test failed:', error);
        return false;
    }
}

function switchMode(mode) {
    currentMode = mode;
    
    // Update buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-mode="${mode}"]`).classList.add('active');
    
    // Update content
    document.querySelectorAll('.mode-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(mode + 'Mode').classList.add('active');
}

// Speech Recognition
function initializeSpeechRecognition() {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = 'en-US';
        
        recognition.onresult = async (event) => {
            // Get the latest result
            const lastResult = event.results[event.results.length - 1];
            if (lastResult.isFinal) {
                const transcript = lastResult[0].transcript;
                addTranscript('You: ' + transcript);
                
                // Analyze tone and send response
                await analyzeAndProcessResponse(transcript);
            }
        };
        
        recognition.onerror = (event) => {
            console.error('Speech recognition error:', event.error);
            showToast('Speech recognition error. Please try again.', 'error');
            stopRecording();
        };
        
        recognition.onend = () => {
            if (isRecording) {
                // Restart if still recording
                try {
                    recognition.start();
                } catch (error) {
                    console.error('Error restarting recognition:', error);
                }
            }
        };
    }
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
        showToast('Speech recognition not supported in your browser', 'error');
        return;
    }
    
    isRecording = true;
    const recordBtn = document.getElementById('recordBtn');
    const avatar = document.querySelector('.avatar');
    
    recordBtn.classList.add('recording');
    recordBtn.querySelector('.btn-text').textContent = 'Listening...';
    
    try {
        recognition.start();
    } catch (error) {
        console.error('Failed to start recording:', error);
        stopRecording();
    }
}

function stopRecording() {
    isRecording = false;
    const recordBtn = document.getElementById('recordBtn');
    
    recordBtn.classList.remove('recording');
    recordBtn.querySelector('.btn-text').textContent = 'Press to Speak';
    
    if (recognition) {
        try {
            recognition.stop();
        } catch (error) {
            console.error('Error stopping recognition:', error);
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

// Chat functionality
function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    addChatMessage(message, 'user');
    input.value = '';
    input.style.height = 'auto';
    
    processUserResponse(message);
}

function addChatMessage(text, sender, isCorrection = false) {
    const chatMessages = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}`;
    if (isCorrection) messageDiv.classList.add('correction');
    
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = sender === 'ai' ? 'AI' : 'You';
    
    const content = document.createElement('div');
    content.className = 'message-content';
    
    if (isCorrection) {
        const label = document.createElement('span');
        label.className = 'correction-label';
        label.textContent = '⚠ Correction';
        content.appendChild(label);
    }
    
    const textNode = document.createElement('div');
    textNode.textContent = text;
    content.appendChild(textNode);
    
    messageDiv.appendChild(avatar);
    messageDiv.appendChild(content);
    chatMessages.appendChild(messageDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// AI Integration
async function sendInitialGreeting() {
    const interviewType = document.getElementById('interviewType').value;
    const difficulty = document.getElementById('difficulty').value;
    
    const prompt = `You are an expert interview coach. Start a ${interviewType} interview at ${difficulty} level. 
    Greet the candidate warmly and ask your first question. Keep your responses natural and conversational.`;
    
    const response = await callGeminiAPI(prompt);
    
    if (currentMode === 'voice') {
        addTranscript('Interviewer: ' + response);
        speakText(response);
    } else {
        addChatMessage(response, 'ai');
    }
    
    questionCount++;
    updateStats();
}

async function analyzeAndProcessResponse(userMessage) {
    // Start media stream for audio capture
    try {
        if (!mediaStream) {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
        
        // Send message with tone analysis request
        const toneAnalysis = await analyzeTone(userMessage);
        await processUserResponse(userMessage, toneAnalysis);
    } catch (error) {
        console.error('Error capturing audio:', error);
        await processUserResponse(userMessage, null);
    }
}

async function analyzeTone(transcript) {
    try {
        const response = await fetch('/api/analyze-tone', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                transcript: transcript,
                api_key: apiKey
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            console.log('Tone analysis:', data);
            return data.tone_analysis;
        } else {
            console.error('Tone analysis error:', data);
            return null;
        }
    } catch (error) {
        console.error('API call failed:', error);
        return null;
    }
}

async function processUserResponse(userMessage, toneAnalysis = null) {
    conversationHistory.push({
        role: 'user',
        content: userMessage,
        tone: toneAnalysis
    });
    
    const interviewType = document.getElementById('interviewType').value;
    const difficulty = document.getElementById('difficulty').value;
    
    let toneContext = '';
    if (toneAnalysis) {
        toneContext = `\n\nTone Analysis of Candidate's Response:
- Confidence Level: ${toneAnalysis.confidence}
- Speech Rate: ${toneAnalysis.speech_rate}
- Emotion: ${toneAnalysis.emotion}
- Nervousness Indicators: ${toneAnalysis.nervousness_level}
- Clarity: ${toneAnalysis.clarity}`;
    }
    
    const prompt = `You are an expert interview coach conducting a ${interviewType} interview at ${difficulty} level.
    
Previous conversation:
${conversationHistory.slice(-5).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

The candidate just said: "${userMessage}"${toneContext}

Analyze their response considering both content AND tone/delivery and:
1. If there are any issues (grammatical errors, unclear statements, weak answers, missed key points, or delivery issues like nervousness), provide a brief, constructive correction starting with "Correction: "
2. Provide encouragement about their tone if they sound confident or show improvement
3. Then, provide your next question or feedback
4. Keep your responses natural and encouraging

Your response:`;
    
    const response = await callGeminiAPI(prompt);
    
    conversationHistory.push({
        role: 'assistant',
        content: response
    });
    
    // Check if response contains a correction
    const hasCorrection = response.toLowerCase().includes('correction:');
    if (hasCorrection) {
        correctionCount++;
        updateStats();
    }
    
    if (currentMode === 'voice') {
        addTranscript('Interviewer: ' + response);
        speakText(response);
    } else {
        addChatMessage(response, 'ai', hasCorrection);
    }
    
    questionCount++;
    updateStats();
}

async function callGeminiAPI(prompt) {
    try {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                api_key: apiKey,
                prompt: prompt,
                history: conversationHistory
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            console.error('API Error:', data);
            showToast(`Error: ${data.error || 'Unknown error'}`, 'error');
            return 'I apologize, but I encountered an error. Could you please repeat that?';
        }
        
        return data.response;
    } catch (error) {
        console.error('API call failed:', error);
        showToast('Failed to get AI response. Please try again.', 'error');
        return 'I apologize, but I encountered an error. Could you please repeat that?';
    }
}

// Text-to-Speech
function speakText(text) {
    if ('speechSynthesis' in window) {
        // Cancel any ongoing speech
        window.speechSynthesis.cancel();
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1;
        utterance.volume = 1;
        
        const avatar = document.querySelector('.avatar');
        
        utterance.onstart = () => {
            avatar.classList.add('talking');
        };
        
        utterance.onend = () => {
            avatar.classList.remove('talking');
        };
        
        window.speechSynthesis.speak(utterance);
    }
}

// Stats and Timer
function startDurationTimer() {
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
    if (confirm('Are you sure you want to start a new interview? This will reset your current session.')) {
        // Reset stats
        conversationHistory = [];
        questionCount = 0;
        correctionCount = 0;
        sessionStartTime = Date.now();
        updateStats();
        
        // Clear chat
        document.getElementById('chatMessages').innerHTML = '';
        document.getElementById('voiceTranscript').innerHTML = '';
        
        // Send new greeting
        sendInitialGreeting();
        
        showToast('New interview session started!', 'success');
    }
}

// ==================== TEACHER MODE FUNCTIONS ====================

function selectAppMode(mode) {
    appMode = mode;
    
    // Update UI
    document.querySelectorAll('.mode-choice-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.getElementById(mode === 'teacher' ? 'teacherModeBtn' : 'interviewerModeBtn').classList.add('active');
}

async function startTeachingSession() {
    if (!apiKey) {
        showToast('Please enter your API key first', 'error');
        return;
    }
    
    const syllabusFile = document.getElementById('syllabusFile').files[0];
    const pyqFile = document.getElementById('pyqFile').files[0];
    
    if (!syllabusFile && !pyqFile) {
        showToast('Please upload at least one PDF file', 'error');
        return;
    }
    
    const formData = new FormData();
    if (syllabusFile) formData.append('syllabus', syllabusFile);
    if (pyqFile) formData.append('pyq', pyqFile);
    
    try {
        const response = await fetch('/api/teacher/session/create', {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            showToast('Error creating session: ' + data.error, 'error');
            return;
        }
        
        teacherSessionId = data.session_id;
        document.getElementById('contentLoaded').textContent = data.content_loaded ? '✓ Yes' : '✗ No';
        
        // Transition to teacher main screen
        document.getElementById('teacherSetup').classList.remove('active');
        document.getElementById('teacherMainScreen').classList.add('active');
        
        showToast('Teaching session started!', 'success');
    } catch (error) {
        console.error('Error:', error);
        showToast('Failed to create session', 'error');
    }
}

function backToModeSelection() {
    document.getElementById('teacherSetup').classList.remove('active');
    document.getElementById('apiSetup').classList.add('active');
    
    // Reset file inputs
    document.getElementById('syllabusFile').value = '';
    document.getElementById('pyqFile').value = '';
    document.getElementById('syllabusInfo').textContent = '';
    document.getElementById('pyqInfo').textContent = '';
}

function switchTeacherMode(mode) {
    currentTeacherMode = mode;
    
    // Update buttons
    document.querySelectorAll('.teacher-mode-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-teacher-mode="${mode}"]`).classList.add('active');
    
    // Update content
    document.querySelectorAll('.teacher-mode-content').forEach(content => {
        content.classList.remove('active');
    });
    
    switch(mode) {
        case 'teach':
            document.getElementById('teachMode').classList.add('active');
            break;
        case 'generate':
            document.getElementById('generateMode').classList.add('active');
            break;
        case 'grade':
            document.getElementById('gradeMode').classList.add('active');
            break;
    }
}

async function sendTeachQuestion() {
    const input = document.getElementById('teachInput');
    const question = input.value.trim();
    
    if (!question || !teacherSessionId) return;
    
    // Add to UI
    addTeachMessage(question, 'student');
    input.value = '';
    
    try {
        const response = await fetch('/api/teacher/teach', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                session_id: teacherSessionId,
                question: question,
                api_key: apiKey
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            showToast('Error: ' + data.error, 'error');
            return;
        }
        
        addTeachMessage(data.response, 'teacher');
    } catch (error) {
        console.error('Error:', error);
        showToast('Failed to get response', 'error');
    }
}

function addTeachMessage(text, sender) {
    const messagesDiv = document.getElementById('teachMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `teach-message ${sender}`;
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'teach-message-content';
    contentDiv.textContent = text;
    
    messageDiv.appendChild(contentDiv);
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

async function generateQuestionPaper() {
    const numQuestions = parseInt(document.getElementById('questionCount').value);
    const difficulty = document.getElementById('paperDifficulty').value;
    const questionTypes = Array.from(document.querySelectorAll('.checkbox-group input:checked'))
        .map(cb => cb.value);
    
    if (!teacherSessionId) {
        showToast('No session active', 'error');
        return;
    }
    
    if (questionTypes.length === 0) {
        showToast('Select at least one question type', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/teacher/generate-paper', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                session_id: teacherSessionId,
                num_questions: numQuestions,
                difficulty: difficulty,
                question_types: questionTypes,
                api_key: apiKey
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            showToast('Error: ' + data.error, 'error');
            return;
        }
        
        const paperDiv = document.getElementById('generatedPaper');
        paperDiv.innerHTML = `
            <div class="paper-content">
                <h3>Generated Question Paper</h3>
                <div class="paper-text">${data.content.replace(/\n/g, '<br>')}</div>
                <button class="primary-btn" onclick="downloadPaper('${data.paper_id}')">Download as PDF</button>
            </div>
        `;
        
        document.getElementById('questionsGenerated').textContent = numQuestions;
        showToast('Question paper generated successfully!', 'success');
    } catch (error) {
        console.error('Error:', error);
        showToast('Failed to generate paper', 'error');
    }
}

function downloadPaper(paperId) {
    window.location.href = `/api/teacher/download-paper/${paperId}`;
}

async function submitForGrading() {
    const studentName = document.getElementById('studentName').value.trim();
    const question = document.getElementById('questionText').value.trim();
    const answer = document.getElementById('studentAnswer').value.trim();
    
    if (!studentName || !question || !answer) {
        showToast('Please fill in all fields', 'error');
        return;
    }
    
    if (!teacherSessionId) {
        showToast('No session active', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/teacher/grade-answer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                session_id: teacherSessionId,
                student_name: studentName,
                question: question,
                answer: answer,
                api_key: apiKey
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            showToast('Error: ' + data.error, 'error');
            return;
        }
        
        const resultDiv = document.getElementById('gradeResult');
        resultDiv.innerHTML = `
            <div class="grading-result">
                <h3>Grading Result for ${studentName}</h3>
                <div class="score-display">${data.score}</div>
                <div class="grading-feedback">${data.grading.replace(/\n/g, '<br>')}</div>
            </div>
        `;
        
        document.getElementById('papersGraded').textContent = 
            parseInt(document.getElementById('papersGraded').textContent) + 1;
        
        showToast('Answer graded successfully!', 'success');
    } catch (error) {
        console.error('Error:', error);
        showToast('Failed to grade answer', 'error');
    }
}

function startNewTeachingSession() {
    if (confirm('Start a new teaching session? Current session will be lost.')) {
        document.getElementById('teacherMainScreen').classList.remove('active');
        document.getElementById('teacherSetup').classList.add('active');
        
        // Reset inputs
        document.getElementById('syllabusFile').value = '';
        document.getElementById('pyqFile').value = '';
        document.getElementById('syllabusInfo').textContent = '';
        document.getElementById('pyqInfo').textContent = '';
        document.getElementById('teachMessages').innerHTML = '';
        document.getElementById('generatedPaper').innerHTML = '';
        document.getElementById('gradeResult').innerHTML = '';
        
        teacherSessionId = null;
    }
}

// Toast notifications
function showToast(message, type = 'info') {
    const toast = document.getElementById('statusToast');
    const messageSpan = toast.querySelector('.toast-message');
    
    messageSpan.textContent = message;
    toast.className = 'status-toast ' + type;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}
